import * as assert from 'assert';
import winston from 'winston';
import { createCheckovInstaller } from '../../checkov/installation';
import { ProcessHost, ProcessResult, RunningProcess, SpawnOptions } from '../../checkov/processHost';
import { ManualClock } from './fakes';

class FakeProcess implements RunningProcess {
    readonly kills: (NodeJS.Signals | undefined)[] = [];
    readonly exited: Promise<ProcessResult>;
    private finish!: (result: ProcessResult) => void;
    private fail!: (error: Error) => void;

    constructor(readonly command: string, readonly args: string[], readonly options: SpawnOptions) {
        this.exited = new Promise((resolve, reject) => {
            this.finish = resolve;
            this.fail = reject;
        });
    }

    exit(code: number | null, stdout = '', stderr = ''): void {
        this.finish({ code, stdout, stderr });
    }

    error(error: Error): void {
        this.fail(error);
    }

    kill(signal?: NodeJS.Signals): void {
        this.kills.push(signal);
    }
}

// Commands with no scripted response fail, as a missing executable would.
class FakeProcessHost implements ProcessHost {
    platform: NodeJS.Platform = 'linux';
    env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    files: Record<string, string> = {};
    readonly commands: string[] = [];
    readonly spawned: FakeProcess[] = [];
    private readonly responses: [string | RegExp, string | Error][] = [];

    respond(command: string | RegExp, result: string | Error = ''): this {
        this.responses.unshift([command, result]);
        return this;
    }

    async execFile(file: string, args: string[]): Promise<[string, string]> {
        const line = [file, ...args].join(' ');
        this.commands.push(line);
        const response = this.responses.find(([command]) => typeof command === 'string' ? command === line : command.test(line));
        if (!response) throw new Error(`command not found: ${line}`);
        if (response[1] instanceof Error) throw response[1];
        return [response[1], ''];
    }

    spawn(command: string, args: string[], options: SpawnOptions): RunningProcess {
        const process = new FakeProcess(command, args, options);
        this.spawned.push(process);
        return process;
    }

    readFile(filePath: string): string {
        if (!(filePath in this.files)) throw new Error(`ENOENT: ${filePath}`);
        return this.files[filePath];
    }

    mkdir(): void {
        return undefined;
    }

    tmpdir(): string {
        return this.platform === 'win32' ? 'C:\\Temp' : '/tmp';
    }
}

const scanOutput = JSON.stringify({
    check_type: 'terraform',
    results: { failed_checks: [{ check_id: 'CKV_AWS_18', check_name: 'Ensure access logging is enabled', file_line_range: [1, 3], resource: 'aws_s3_bucket.a', guideline: 'https://docs.example.com/ckv-aws-18' }] }
});

const request = { filePath: '/work/repo/infra/main.tf', workspaceRoot: '/work/repo', configPaths: [] };

const valueAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1];

const dockerHost = () => new FakeProcessHost()
    .respond('docker pull bridgecrew/checkov:3.2.1')
    .respond('git -C /work/repo/infra remote -v', 'origin\tgit@github.com:xargsuk/infra.git (fetch)\norigin\tgit@github.com:xargsuk/infra.git (push)\n');

const localHost = () => new FakeProcessHost()
    .respond('checkov --version', '3.2.1\n')
    .respond('checkov -v', '3.2.1\n');

// Lets a scan that was just requested reach the point where it starts Checkov.
const started = async (host: FakeProcessHost): Promise<FakeProcess> => {
    const before = host.spawned.length;
    for (let attempt = 0; attempt < 10 && host.spawned.length === before; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.strictEqual(host.spawned.length, before + 1, 'Checkov was started');
    return host.spawned[before];
};

const setup = (host = new FakeProcessHost(), clock = new ManualClock()) => ({
    host,
    clock,
    installer: createCheckovInstaller({
        host,
        clock,
        logger: winston.createLogger({ silent: true }),
        installationDir: '/storage/checkov-installation',
        extensionVersion: '1.2.0'
    })
});

suite('Checkov installation', () => {
    test('uses Docker when the requested image can be pulled, and shows the requested version', async () => {
        const { host, installer } = setup();
        host.respond('docker pull bridgecrew/checkov:3.2.1');

        const installation = await installer.install('3.2.1');

        assert.strictEqual(installation.method, 'docker');
        assert.strictEqual(installation.displayVersion, '3.2.1');
        assert.deepStrictEqual(host.commands, ['docker pull bridgecrew/checkov:3.2.1']);
    });

    test('resolves "latest" to the real version and caches it for an hour, until the version cache is cleared', async () => {
        const { host, clock, installer } = setup();
        host.respond('docker pull bridgecrew/checkov:latest')
            .respond('docker run --rm --interactive bridgecrew/checkov:latest -v', '3.2.400\n')
            .respond('docker pull bridgecrew/checkov:3.2.400');
        const resolutions = () => host.commands.filter(command => command.includes('-v')).length;

        assert.strictEqual((await installer.install('latest')).displayVersion, '3.2.400');
        await installer.install('latest');
        assert.strictEqual(resolutions(), 1);

        installer.clearVersionCache();
        await installer.install('latest');
        assert.strictEqual(resolutions(), 2);

        await clock.advance(60 * 60 * 1000);
        await installer.install('latest');
        assert.strictEqual(resolutions(), 3);
    });

    test('uses the latest image when the latest version has no tag of its own', async () => {
        const { host, installer } = setup();
        host.respond('docker pull bridgecrew/checkov:latest')
            .respond('docker run --rm --interactive bridgecrew/checkov:latest -v', '3.2.401\n');

        const installation = await installer.install('latest');

        assert.strictEqual(installation.method, 'docker');
        assert.strictEqual(installation.displayVersion, '3.2.401');
    });

    test('falls back to the latest image when the requested version cannot be pulled', async () => {
        const { host, installer } = setup();
        host.respond('docker pull bridgecrew/checkov:latest')
            .respond('docker run --rm --interactive bridgecrew/checkov:latest -v', '3.2.400\n')
            .respond('docker pull bridgecrew/checkov:3.2.400');

        const installation = await installer.install('3.0.0');

        assert.strictEqual(installation.method, 'docker');
        assert.strictEqual(installation.displayVersion, '3.2.400');
    });

    test('falls back to pip3 when Docker is unavailable, and shows the installed version', async () => {
        const { host, installer } = setup();
        host.respond('python3 --version', 'Python 3.11.4\n')
            .respond('pip3 install --user -U -i https://pypi.org/simple/ checkov==3.2.1')
            .respond('python3 -c import site; print(site.USER_BASE)', '/home/dev/.local\n')
            .respond('/home/dev/.local/bin/checkov -v', '3.2.1\n');

        const installation = await installer.install('3.2.1');

        assert.strictEqual(installation.method, 'pip3');
        assert.strictEqual(installation.displayVersion, '3.2.1');
    });

    test('uses a checkov already on the PATH after a pip3 install', async () => {
        const { host, installer } = setup();
        host.respond('python3 --version', 'Python 3.11.4\n')
            .respond('pip3 install --user -U -i https://pypi.org/simple/ checkov')
            .respond('checkov --version', '3.2.400\n')
            .respond('checkov -v', '3.2.400\n');

        const installation = await installer.install('latest');

        assert.strictEqual(installation.method, 'pip3');
        assert.strictEqual(installation.displayVersion, '3.2.400');
    });

    test('retries with python and pip, and finds the user scripts with that interpreter', async () => {
        const { host, installer } = setup();
        host.respond('python3 --version', 'Python 3.6.9\n')
            .respond('python --version', 'Python 3.12.1\n')
            .respond('pip install --user -U -i https://pypi.org/simple/ checkov==3.2.1')
            .respond('python -c import site; print(site.USER_BASE)', '/home/dev/.local\n')
            .respond('/home/dev/.local/bin/checkov -v', '3.2.1\n');

        const installation = await installer.install('3.2.1');

        assert.strictEqual(installation.method, 'pip3');
        assert.ok(!host.commands.some(command => command.startsWith('pip3 install')), 'Python 3.6 is too old to install with');
    });

    test('falls back to pipenv when pip cannot install, and installs an unpinned checkov for "latest"', async () => {
        const { host, installer } = setup();
        host.respond('pipenv run python --version', 'Python 3.10.0\n')
            .respond('pipenv --python 3 install checkov')
            .respond('pipenv run which python', '/venvs/checkov/bin/python\n')
            .respond('/venvs/checkov/bin/checkov -v', '3.2.400\n');

        const installation = await installer.install('latest');

        assert.strictEqual(installation.method, 'pipenv');
        assert.strictEqual(installation.displayVersion, '3.2.400');
    });

    test('falls back to a global checkov, labelled as global, when nothing can be installed', async () => {
        const { host, installer } = setup();
        host.respond('checkov --version', '2.5.0\n').respond('checkov -v', '2.5.0\n');

        const installation = await installer.install('3.2.1');

        assert.strictEqual(installation.method, 'global');
        assert.strictEqual(installation.displayVersion, '2.5.0');
    });

    test('fails when no installation method works', async () => {
        const { installer } = setup();

        await assert.rejects(installer.install('3.2.1'), /Could not install Checkov/);
    });

    test('still installs when the version cannot be read', async () => {
        const { host, installer } = setup();
        host.respond('checkov --version', '2.5.0\n');

        const installation = await installer.install('latest');

        assert.strictEqual(installation.method, 'global');
        assert.strictEqual(installation.displayVersion, undefined);
    });

    test('on Windows, runs a global checkov.cmd script with the real interpreter behind the python shims', async () => {
        const host = new FakeProcessHost();
        host.platform = 'win32';
        host.respond('where.exe checkov', 'C:\\Python312\\Scripts\\checkov.cmd\r\n')
            .respond('python.exe -', 'C:\\Python312\\python.exe\r\n')
            .respond('C:\\Python312\\python.exe C:\\Python312\\Scripts\\checkov --version', '3.2.1\r\n')
            .respond('C:\\Python312\\python.exe C:\\Python312\\Scripts\\checkov -v', '3.2.1\r\n');
        const { installer } = setup(host);

        const installation = await installer.install('latest');

        assert.strictEqual(installation.method, 'global');
        assert.strictEqual(installation.displayVersion, '3.2.1');
    });

    test('on Windows, a pip install falls back to python and to the interpreter in the script\'s shebang', async () => {
        const host = new FakeProcessHost();
        host.platform = 'win32';
        const script = 'C:\\Users\\dev\\AppData\\Roaming\\Python\\Python312\\Scripts\\checkov';
        host.files[script] = '#!"C:\\Program Files\\Python312\\python.exe"\r\nimport checkov\r\n';
        host.respond('python --version', 'Python 3.12.1\r\n')
            .respond('pip3 install --user -U -i https://pypi.org/simple/ checkov==3.2.1')
            .respond('pip3 show checkov', 'Name: checkov\r\nLocation: C:\\Users\\dev\\AppData\\Roaming\\Python\\Python312\\site-packages\r\n')
            .respond(`C:\\Program Files\\Python312\\python.exe ${script} --version`, '3.2.1\r\n')
            .respond(`C:\\Program Files\\Python312\\python.exe ${script} -v`, '3.2.1\r\n');
        const { installer } = setup(host);

        const installation = await installer.install('3.2.1');

        assert.strictEqual(installation.method, 'pip3');
        assert.strictEqual(installation.displayVersion, '3.2.1');
    });

    test('a Docker scan runs the installed image with the repository of the scanned file, and returns its findings', async () => {
        const host = dockerHost();
        const installation = await setup(host).installer.install('3.2.1');

        const findings = installation.scan(request, new AbortController().signal);
        const checkov = await started(host);
        checkov.exit(0, scanOutput);

        assert.deepStrictEqual((await findings).map(finding => [finding.checkId, finding.fileLineRange]), [['CKV_AWS_18', [1, 3]]]);
        assert.strictEqual(checkov.command, 'docker');
        assert.ok(checkov.args.includes('bridgecrew/checkov:3.2.1'));
        assert.strictEqual(valueAfter(checkov.args, '--repo-id'), 'xargsuk/infra');
        assert.strictEqual(checkov.options.cwd, '/tmp');
    });

    test('a local scan runs in the workspace folder with the Checkov environment variables', async () => {
        const host = localHost();
        const installation = await setup(host).installer.install('latest');

        const findings = installation.scan({ ...request, debugLogs: true }, new AbortController().signal);
        const checkov = await started(host);
        checkov.exit(0, '[]');

        assert.deepStrictEqual(await findings, []);
        assert.strictEqual(checkov.command, 'checkov');
        assert.strictEqual(valueAfter(checkov.args, '-f'), '/work/repo/infra/main.tf');
        assert.strictEqual(valueAfter(checkov.args, '--repo-id'), 'vscode/default');
        assert.strictEqual(checkov.options.cwd, '/work/repo');
        assert.deepStrictEqual([checkov.options.env.BC_SOURCE, checkov.options.env.BC_SOURCE_VERSION, checkov.options.env.LOG_LEVEL, checkov.options.env.PATH],
            ['vscode', '1.2.0', 'DEBUG', '/usr/bin']);
    });

    test('log lines and colour codes around the JSON are ignored', async () => {
        const host = dockerHost();
        const installation = await setup(host).installer.install('3.2.1');

        const findings = installation.scan(request, new AbortController().signal);
        (await started(host)).exit(0, `2026-10-18 12:00:00 Checking for updates\n\u001b[0m${scanOutput}\u001b[0m\n`);

        assert.strictEqual((await findings).length, 1);
    });

    test('a non-zero exit, or output without results, is reported as an error', async () => {
        const host = localHost();
        const installation = await setup(host).installer.install('latest');

        const failed = installation.scan(request, new AbortController().signal);
        (await started(host)).exit(2, scanOutput);
        await assert.rejects(failed, /exited with code 2/);

        const empty = installation.scan(request, new AbortController().signal);
        (await started(host)).exit(0, 'Something went wrong\n');
        await assert.rejects(empty, /no results/);
    });

    test('cancelling a Docker scan kills its container', async () => {
        const host = dockerHost().respond(/^docker kill /);
        const installation = await setup(host).installer.install('3.2.1');
        const cancel = new AbortController();

        const findings = installation.scan(request, cancel.signal);
        const checkov = await started(host);
        cancel.abort();
        checkov.exit(137);

        await assert.rejects(findings, /cancelled/);
        assert.ok(host.commands.includes(`docker kill ${valueAfter(checkov.args, '--name')}`));
        assert.deepStrictEqual(checkov.kills, []);
    });

    test('cancelling a local scan kills the process, without a signal name on Windows', async () => {
        for (const [platform, expected] of [['linux', 'SIGABRT'], ['win32', undefined]] as const) {
            const host = localHost();
            host.platform = platform;
            host.respond('where.exe checkov', 'C:\\tools\\checkov.exe\r\n')
                .respond('C:\\tools\\checkov.exe --version', '3.2.1\r\n')
                .respond('C:\\tools\\checkov.exe -v', '3.2.1\r\n');
            const installation = await setup(host).installer.install('latest');
            const cancel = new AbortController();

            const findings = installation.scan(request, cancel.signal);
            const checkov = await started(host);
            cancel.abort();
            checkov.exit(null);

            await assert.rejects(findings, /cancelled/);
            assert.deepStrictEqual(checkov.kills, [expected], platform);
        }
    });

    test('a scan cancelled before Checkov starts never starts it', async () => {
        const host = dockerHost();
        const installation = await setup(host).installer.install('3.2.1');
        const cancel = new AbortController();

        const findings = installation.scan(request, cancel.signal);
        cancel.abort();

        await assert.rejects(findings, /cancelled/);
        assert.strictEqual(host.spawned.length, 0);
    });

    test('output that is not valid JSON, or a process that cannot start, is reported as a Checkov error', async () => {
        const host = localHost();
        const installation = await setup(host).installer.install('latest');

        const garbled = installation.scan(request, new AbortController().signal);
        (await started(host)).exit(0, '[ WARNING ] update available\n');
        await assert.rejects(garbled, /Checkov returned output that is not valid JSON: \[ WARNING \]/);

        const missing = installation.scan(request, new AbortController().signal);
        (await started(host)).error(new Error('spawn checkov ENOENT'));
        await assert.rejects(missing, /ENOENT/);
    });

    test('a hostile file name reaches Checkov as a single argument', async () => {
        const host = localHost();
        const installation = await setup(host).installer.install('latest');
        const filePath = '/work/repo/main$(touch pwned)`id`"; rm -rf ~ #.tf';

        const findings = installation.scan({ ...request, filePath }, new AbortController().signal);
        const checkov = await started(host);
        checkov.exit(0, '[]');
        await findings;

        assert.strictEqual(checkov.command, 'checkov');
        assert.strictEqual(valueAfter(checkov.args, '-f'), filePath);
    });
});
