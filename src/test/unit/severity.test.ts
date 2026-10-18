import * as assert from 'assert';
import winston from 'winston';
import { createSeverityMappings, displayLevel, MappingSource, meetsMinimumSeverity } from '../../severity';
import { InMemoryMemento, ManualClock, settle } from './fakes';

class FakeMappingSource implements MappingSource {
    releaseVersion = 'v2026.09.16-1344';
    file: unknown = { metadata: { version: '1.0' }, mappings: { CKV_AWS_1: 'HIGH', ckv_aws_2: 'LOW' } };
    offline = false;
    releaseChecks = 0;
    mappingDownloads = 0;

    async fetchReleaseVersion(): Promise<string> {
        this.releaseChecks++;
        if (this.offline) throw new Error('offline');
        return this.releaseVersion;
    }

    async fetchMappings(): Promise<unknown> {
        this.mappingDownloads++;
        if (this.offline) throw new Error('offline');
        return this.file;
    }
}

const setup = (cache = new InMemoryMemento(), source = new FakeMappingSource(), clock = new ManualClock()) => {
    const changes: string[] = [];
    const severityMappings = createSeverityMappings({
        source,
        cache,
        clock,
        logger: winston.createLogger({ silent: true }),
        onMappingsChanged: change => changes.push(change)
    });
    return { severityMappings, source, cache, clock, changes };
};

suite('severity mappings', () => {
    test('resolves from the mapping, then the severity Checkov reported, then UNKNOWN', async () => {
        const { severityMappings } = setup();
        await settle();

        assert.strictEqual(severityMappings.resolve('CKV_AWS_1', 'LOW'), 'HIGH');
        assert.strictEqual(severityMappings.resolve('CKV_AWS_2', undefined), 'LOW');
        assert.strictEqual(severityMappings.resolve('CKV_AWS_99', 'MEDIUM'), 'MEDIUM');
        assert.strictEqual(severityMappings.resolve('CKV_AWS_99', undefined), 'UNKNOWN');
    });

    test('a refresh of the same release reports no change and does not download the mappings again', async () => {
        const { severityMappings, source } = setup();
        await settle();

        assert.strictEqual(await severityMappings.refresh(), 'unchanged');
        assert.strictEqual(source.mappingDownloads, 1);
    });

    test('a refresh of a new release reports the change and uses the new mappings', async () => {
        const { severityMappings, source } = setup();
        await settle();
        source.releaseVersion = 'v2026.10.01-0900';
        source.file = { mappings: { CKV_AWS_1: 'CRITICAL' } };

        assert.strictEqual(await severityMappings.refresh(), 'updated');
        assert.strictEqual(severityMappings.resolve('CKV_AWS_1', undefined), 'CRITICAL');
        assert.strictEqual(severityMappings.resolve('CKV_AWS_2', 'MEDIUM'), 'MEDIUM');
    });

    test('a restart uses the cached mappings at once and only checks for a new release once the cache is a day old', async () => {
        const cache = new InMemoryMemento();
        const clock = new ManualClock();
        setup(cache, new FakeMappingSource(), clock).severityMappings.dispose();
        await settle();

        const offline = new FakeMappingSource();
        offline.offline = true;
        const restarted = setup(cache, offline, clock).severityMappings;
        assert.strictEqual(restarted.resolve('CKV_AWS_1', undefined), 'HIGH');
        await settle();
        assert.strictEqual(offline.releaseChecks, 0);
        restarted.dispose();

        await clock.advance(24 * 60 * 60 * 1000);
        const dayLater = new FakeMappingSource();
        setup(cache, dayLater, clock).severityMappings.dispose();
        await settle();
        assert.strictEqual(dayLater.releaseChecks, 1);
    });

    test('reports the first load, then checks every hour and reports only real changes', async () => {
        const { severityMappings, source, clock, changes } = setup();
        await settle();
        assert.deepStrictEqual(changes, ['loaded']);

        await clock.advance(60 * 60 * 1000);
        assert.deepStrictEqual(changes, ['loaded']);

        source.releaseVersion = 'v2026.10.01-0900';
        source.file = { mappings: { CKV_AWS_1: 'LOW' } };
        await clock.advance(60 * 60 * 1000);
        assert.deepStrictEqual(changes, ['loaded', 'updated']);
        assert.strictEqual(severityMappings.resolve('CKV_AWS_1', undefined), 'LOW');

        severityMappings.dispose();
        source.releaseVersion = 'v2026.11.01-0900';
        await clock.advance(60 * 60 * 1000);
        assert.deepStrictEqual(changes, ['loaded', 'updated']);
    });

    test('a failed or invalid download keeps the mappings already loaded', async () => {
        const { severityMappings, source } = setup();
        await settle();

        source.offline = true;
        await assert.rejects(severityMappings.refresh());
        assert.strictEqual(severityMappings.resolve('CKV_AWS_1', undefined), 'HIGH');

        source.offline = false;
        source.releaseVersion = 'v2026.10.01-0900';
        for (const file of [{}, { mappings: {} }, { mappings: { CKV_AWS_1: 'SEVERE' } }]) {
            source.file = file;
            await assert.rejects(severityMappings.refresh());
        }
        assert.strictEqual(severityMappings.resolve('CKV_AWS_1', undefined), 'HIGH');
    });

    test('a first run without network falls back to the severity Checkov reported', async () => {
        const source = new FakeMappingSource();
        source.offline = true;
        const { severityMappings, changes } = setup(new InMemoryMemento(), source);
        await settle();

        assert.strictEqual(severityMappings.resolve('CKV_AWS_1', 'MEDIUM'), 'MEDIUM');
        assert.strictEqual(severityMappings.resolve('CKV_AWS_1', undefined), 'UNKNOWN');
        assert.deepStrictEqual(changes, []);
    });

    test('a day-old cache is still used when the network is down', async () => {
        const cache = new InMemoryMemento();
        const clock = new ManualClock();
        setup(cache, new FakeMappingSource(), clock).severityMappings.dispose();
        await settle();
        await clock.advance(25 * 60 * 60 * 1000);

        const offline = new FakeMappingSource();
        offline.offline = true;
        const { severityMappings } = setup(cache, offline, clock);
        await settle();

        assert.strictEqual(offline.releaseChecks, 1);
        assert.strictEqual(severityMappings.resolve('CKV_AWS_1', undefined), 'HIGH');
    });

    test('mappings cached by the previous severity provider are used until the first refresh', async () => {
        const cache = new InMemoryMemento();
        await cache.update('checkov_severity_mappings', { data: { metadata: { version: '1.0' }, mappings: { CKV_AWS_3: 'CRITICAL' } }, cached_at: '2026-09-16T13:44:11Z' });
        const offline = new FakeMappingSource();
        offline.offline = true;

        const { severityMappings } = setup(cache, offline);
        await settle();

        assert.strictEqual(severityMappings.resolve('CKV_AWS_3', undefined), 'CRITICAL');
        assert.strictEqual(cache.get('checkov_severity_mappings'), undefined);
        assert.strictEqual(offline.releaseChecks, 1);
    });

    test('overlapping refreshes share one download', async () => {
        const { severityMappings, source } = setup();
        const results = await Promise.all([severityMappings.refresh(), severityMappings.refresh()]);

        assert.strictEqual(source.mappingDownloads, 1);
        assert.deepStrictEqual(results, ['updated', 'updated']);
    });
});

suite('meetsMinimumSeverity', () => {
    test('shows everything when no minimum is set', () => {
        assert.ok(meetsMinimumSeverity('INFO', 'None'));
        assert.ok(meetsMinimumSeverity('INFO', 'none'));
        assert.ok(meetsMinimumSeverity('LOW', ''));
    });

    test('hides findings below the minimum', () => {
        assert.ok(!meetsMinimumSeverity('LOW', 'MEDIUM'));
        assert.ok(!meetsMinimumSeverity('INFO', 'LOW'));
        assert.ok(!meetsMinimumSeverity('HIGH', 'CRITICAL'));
    });

    test('shows findings at or above the minimum', () => {
        assert.ok(meetsMinimumSeverity('MEDIUM', 'MEDIUM'));
        assert.ok(meetsMinimumSeverity('CRITICAL', 'HIGH'));
        assert.ok(meetsMinimumSeverity('HIGH', 'Medium'));
        assert.ok(!meetsMinimumSeverity('LOW', 'Medium'));
        assert.ok(meetsMinimumSeverity('high', 'medium'));
    });

    test('never hides a finding with an unknown severity', () => {
        assert.ok(meetsMinimumSeverity('UNKNOWN', 'CRITICAL'));
        assert.ok(meetsMinimumSeverity('', 'CRITICAL'));
    });
});

suite('displayLevel', () => {
    test('shows critical and high as errors, medium and unknown as warnings, low and info as information', () => {
        assert.deepStrictEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'UNKNOWN', 'LOW', 'INFO', 'low'].map(displayLevel),
            ['error', 'error', 'warning', 'warning', 'information', 'information', 'information']);
    });
});
