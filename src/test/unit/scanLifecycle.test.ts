import * as assert from 'assert';
import type { Memento } from 'vscode';
import winston from 'winston';
import { FailedCheckovCheck } from '../../checkov/models';
import { Clock, createScanLifecycle, ScanLimits, ScanRequest } from '../../scanLifecycle';

type Options = { label: string };

class ManualClock implements Clock {
    private time = Date.UTC(2026, 9, 18, 12);
    private nextId = 0;
    private readonly timers = new Map<number, { at: number, callback: () => void }>();

    setTimeout(callback: () => void, ms: number): number {
        this.nextId++;
        this.timers.set(this.nextId, { at: this.time + ms, callback });
        return this.nextId;
    }

    clearTimeout(handle: unknown): void {
        this.timers.delete(handle as number);
    }

    now(): number {
        return this.time;
    }

    async advance(ms: number): Promise<void> {
        const target = this.time + ms;
        while (true) {
            const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
            if (!due) break;
            const [id, timer] = due;
            this.timers.delete(id);
            this.time = timer.at;
            timer.callback();
            await settle();
        }
        this.time = target;
        await settle();
    }
}

// Returns copies so a caller that mutates a value without calling update() loses the change, as a persisted Memento would.
class InMemoryMemento implements Memento {
    private readonly values = new Map<string, string>();

    keys(): readonly string[] {
        return [...this.values.keys()];
    }

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        const value = this.values.get(key);
        return value === undefined ? defaultValue : JSON.parse(value);
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, JSON.stringify(value));
        }
    }
}

type Invocation = {
    filePath: string,
    options: Options,
    signal: AbortSignal,
    resolve: (findings: FailedCheckovCheck[]) => void,
    reject: (error: unknown) => void
};

class FakeCheckov {
    readonly invocations: Invocation[] = [];

    readonly invoke = (filePath: string, options: Options, signal: AbortSignal): Promise<FailedCheckovCheck[]> =>
        new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject('Cancel invoked'));
            this.invocations.push({ filePath, options, signal, resolve, reject });
        });
}

const settle = () => new Promise(resolve => setImmediate(resolve));

const finding = (checkId: string): FailedCheckovCheck => ({
    checkId,
    checkName: `${checkId} name`,
    fileLineRange: [1, 2],
    resource: 'aws_s3_bucket.example'
});

const request = (uri: string, overrides: Partial<ScanRequest<Options>> = {}): ScanRequest<Options> => ({
    uri,
    filePath: uri.replace('file://', ''),
    cacheKey: `${uri}-hash`,
    useCache: true,
    options: { label: uri },
    ...overrides
});

const setup = (limits: ScanLimits = { timeoutSeconds: 60, maximumConcurrentScans: 2 }) => {
    const clock = new ManualClock();
    const checkov = new FakeCheckov();
    const cache = new InMemoryMemento();
    const currentLimits = { ...limits };
    const lifecycle = createScanLifecycle<Options>({
        invoke: checkov.invoke,
        cache,
        limits: () => currentLimits,
        clock,
        logger: winston.createLogger({ silent: true })
    });
    return { clock, checkov, cache, limits: currentLimits, lifecycle };
};

suite('scan lifecycle', () => {
    test('runs Checkov after the debounce and returns the findings for the requested document', async () => {
        const { clock, checkov, lifecycle } = setup();

        const outcome = lifecycle.scan(request('file:///repo/main.tf'));
        await settle();
        assert.strictEqual(checkov.invocations.length, 0);

        await clock.advance(100);
        assert.strictEqual(checkov.invocations.length, 1);
        assert.strictEqual(checkov.invocations[0].filePath, '/repo/main.tf');
        checkov.invocations[0].resolve([finding('CKV_AWS_1')]);

        assert.deepStrictEqual(await outcome, {
            kind: 'findings',
            uri: 'file:///repo/main.tf',
            findings: [finding('CKV_AWS_1')]
        });
    });

    test('a new request for the same document cancels the scan still running', async () => {
        const { clock, checkov, lifecycle } = setup();

        const first = lifecycle.scan(request('file:///repo/main.tf'));
        await clock.advance(100);
        const second = lifecycle.scan(request('file:///repo/main.tf'));

        assert.deepStrictEqual(await first, { kind: 'cancelled', uri: 'file:///repo/main.tf', reason: 'superseded' });
        assert.ok(checkov.invocations[0].signal.aborted);

        await clock.advance(100);
        checkov.invocations[1].resolve([]);
        assert.strictEqual((await second).kind, 'findings');
    });

    test('rapid requests for one document run Checkov once with the latest request', async () => {
        const { clock, checkov, lifecycle } = setup();

        const first = lifecycle.scan(request('file:///repo/main.tf', { options: { label: 'first' } }));
        await clock.advance(50);
        lifecycle.scan(request('file:///repo/main.tf', { options: { label: 'latest' } }));
        await clock.advance(100);

        assert.deepStrictEqual(await first, { kind: 'cancelled', uri: 'file:///repo/main.tf', reason: 'superseded' });
        assert.deepStrictEqual(checkov.invocations.map(invocation => invocation.options.label), ['latest']);
    });

    test('requests for two documents within the debounce both run', async () => {
        const { clock, checkov, lifecycle } = setup();

        lifecycle.scan(request('file:///repo/main.tf'));
        lifecycle.scan(request('file:///repo/variables.tf'));
        await clock.advance(100);

        assert.deepStrictEqual(checkov.invocations.map(invocation => invocation.filePath), ['/repo/main.tf', '/repo/variables.tf']);
    });

    test('the concurrency cap cancels the oldest running scan, using the cap at the time the scan starts', async () => {
        const { clock, checkov, limits, lifecycle } = setup({ timeoutSeconds: 60, maximumConcurrentScans: 2 });

        const oldest = lifecycle.scan(request('file:///repo/a.tf'));
        lifecycle.scan(request('file:///repo/b.tf'));
        await clock.advance(100);
        lifecycle.scan(request('file:///repo/c.tf'));
        await settle();
        assert.ok(!checkov.invocations[0].signal.aborted, 'a scan still waiting on the debounce does not count towards the cap');

        await clock.advance(100);
        assert.deepStrictEqual(await oldest, { kind: 'cancelled', uri: 'file:///repo/a.tf', reason: 'limit' });

        limits.maximumConcurrentScans = 1;
        lifecycle.scan(request('file:///repo/d.tf'));
        await clock.advance(100);

        assert.deepStrictEqual(checkov.invocations.map(invocation => [invocation.filePath, invocation.signal.aborted]), [
            ['/repo/a.tf', true],
            ['/repo/b.tf', true],
            ['/repo/c.tf', true],
            ['/repo/d.tf', false]
        ]);
    });

    test('a scan that runs past the timeout is stopped and reported as timed out', async () => {
        const { clock, checkov, lifecycle } = setup({ timeoutSeconds: 30, maximumConcurrentScans: 2 });

        const outcome = lifecycle.scan(request('file:///repo/main.tf'));
        await clock.advance(100 + 29_999);
        assert.ok(!checkov.invocations[0].signal.aborted);

        await clock.advance(1);
        assert.ok(checkov.invocations[0].signal.aborted);
        assert.deepStrictEqual(await outcome, { kind: 'timedOut', uri: 'file:///repo/main.tf', timeoutSeconds: 30 });
    });

    test('an unchanged file is answered from the cache without running Checkov', async () => {
        const { clock, checkov, lifecycle } = setup();
        const first = lifecycle.scan(request('file:///repo/main.tf'));
        await clock.advance(100);
        checkov.invocations[0].resolve([finding('CKV_AWS_1')]);
        await first;

        const cached = await lifecycle.scan(request('file:///repo/main.tf'));

        assert.deepStrictEqual(cached, {
            kind: 'findings',
            uri: 'file:///repo/main.tf',
            findings: [finding('CKV_AWS_1')]
        });
        assert.strictEqual(checkov.invocations.length, 1);
    });

    test('a changed file, a forced scan or a new day runs Checkov again', async () => {
        const { clock, checkov, lifecycle } = setup();
        const scanAndResolve = async (overrides: Partial<ScanRequest<Options>>) => {
            const outcome = lifecycle.scan(request('file:///repo/main.tf', overrides));
            await clock.advance(100);
            checkov.invocations[checkov.invocations.length - 1]?.resolve([]);
            return outcome;
        };

        await scanAndResolve({});
        assert.strictEqual((await scanAndResolve({ cacheKey: 'changed-hash' })).kind, 'findings');
        assert.strictEqual(checkov.invocations.length, 2);

        await scanAndResolve({ useCache: false });
        assert.strictEqual(checkov.invocations.length, 3);

        await clock.advance(24 * 60 * 60 * 1000);
        await scanAndResolve({});
        assert.strictEqual(checkov.invocations.length, 4);
    });

    test('a cancelled scan does not cache findings that arrive late', async () => {
        const { clock, checkov, lifecycle } = setup();
        lifecycle.scan(request('file:///repo/main.tf'));
        await clock.advance(100);
        lifecycle.cancel('file:///repo/main.tf');
        checkov.invocations[0].resolve([finding('CKV_AWS_1')]);
        await settle();

        lifecycle.scan(request('file:///repo/main.tf'));
        await clock.advance(100);
        assert.strictEqual(checkov.invocations.length, 2);
    });

    test('a failed Checkov invocation is reported as an error', async () => {
        const { clock, checkov, lifecycle } = setup();
        const outcome = lifecycle.scan(request('file:///repo/main.tf'));
        await clock.advance(100);
        const error = new Error('Checkov exited with code 2');
        checkov.invocations[0].reject(error);

        assert.deepStrictEqual(await outcome, { kind: 'error', uri: 'file:///repo/main.tf', error });
    });

    test('cancelling all scans stops pending and running scans', async () => {
        const { clock, checkov, lifecycle } = setup();
        const running = lifecycle.scan(request('file:///repo/main.tf'));
        await clock.advance(100);
        const pending = lifecycle.scan(request('file:///repo/variables.tf'));

        lifecycle.cancelAll();
        await clock.advance(100);

        assert.deepStrictEqual(await running, { kind: 'cancelled', uri: 'file:///repo/main.tf', reason: 'requested' });
        assert.deepStrictEqual(await pending, { kind: 'cancelled', uri: 'file:///repo/variables.tf', reason: 'requested' });
        assert.ok(checkov.invocations[0].signal.aborted);
        assert.strictEqual(checkov.invocations.length, 1);
    });
});
