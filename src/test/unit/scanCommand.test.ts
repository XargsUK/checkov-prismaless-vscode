import * as assert from 'assert';
import * as path from 'path';
import { buildScanCommand, parseShebangInterpreter, resolveExternalChecksDir, sanitiseOptionValues, ScanCommandOptions } from '../../checkov/scanCommand';

const dockerOptions: ScanCommandOptions = {
    installationMethod: 'docker',
    checkovPath: 'docker',
    dockerImageTag: '3.2.1',
    containerName: 'vscode-checkov-1',
    extensionVersion: '1.1.0',
    workspaceRoot: '/work/repo',
    filePath: '/work/repo/infra/main.tf'
};

const localOptions: ScanCommandOptions = {
    ...dockerOptions,
    installationMethod: 'pip3',
    checkovPath: '/home/dev/.local/bin/checkov'
};

const valueAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1];
const mounts = (args: string[]): string[] => args.filter((_, index) => args[index - 1] === '-v');

suite('buildScanCommand', () => {
    test('passes hostile file names as a single argument', () => {
        const filePath = '/work/repo/main$(touch pwned)`id`"; rm -rf ~ #.tf';
        const { command, args } = buildScanCommand({ ...localOptions, filePath }, path.posix);

        assert.strictEqual(command, '/home/dev/.local/bin/checkov');
        assert.strictEqual(valueAfter(args, '-f'), filePath);
    });

    test('mounts the workspace read-only and scans the relative path', () => {
        const { command, args } = buildScanCommand(dockerOptions, path.posix);

        assert.strictEqual(command, 'docker');
        assert.deepStrictEqual(mounts(args), ['/work/repo:/checkovScan:ro']);
        assert.strictEqual(valueAfter(args, '-f'), 'infra/main.tf');
        assert.strictEqual(valueAfter(args, '--name'), 'vscode-checkov-1');
        assert.ok(args.includes('bridgecrew/checkov:3.2.1'));
    });

    test('mounts only the file when it is outside the workspace', () => {
        const { args } = buildScanCommand({ ...dockerOptions, filePath: '/home/dev/notes.yaml' }, path.posix);

        assert.deepStrictEqual(mounts(args), ['/home/dev/notes.yaml:/checkovScan/notes.yaml:ro']);
        assert.strictEqual(valueAfter(args, '-f'), 'notes.yaml');
    });

    test('mounts only the file when there is no workspace', () => {
        const { args } = buildScanCommand({ ...dockerOptions, workspaceRoot: undefined }, path.posix);

        assert.deepStrictEqual(mounts(args), ['/work/repo/infra/main.tf:/checkovScan/main.tf:ro']);
    });

    test('does not treat a sibling directory with the same prefix as the workspace', () => {
        const { args } = buildScanCommand({ ...dockerOptions, filePath: '/work/repo-other/main.tf' }, path.posix);

        assert.deepStrictEqual(mounts(args), ['/work/repo-other/main.tf:/checkovScan/main.tf:ro']);
    });

    test('converts Windows paths for the container', () => {
        const { args } = buildScanCommand({ ...dockerOptions, workspaceRoot: 'C:\\work\\repo', filePath: 'C:\\work\\repo\\infra\\main.tf' }, path.win32);

        assert.deepStrictEqual(mounts(args), ['C:\\work\\repo:/checkovScan:ro']);
        assert.strictEqual(valueAfter(args, '-f'), 'infra/main.tf');
    });

    test('stops a file name starting with a dash being read as an option', () => {
        const { args } = buildScanCommand({ ...dockerOptions, filePath: '/work/repo/--external-checks-dir=.' }, path.posix);

        assert.strictEqual(valueAfter(args, '-f'), './--external-checks-dir=.');
    });

    test('mounts config, certificate and external checks read-only', () => {
        const { args } = buildScanCommand({
            ...dockerOptions,
            configFilePath: '/work/repo/infra/.checkov.yaml',
            certPath: '/etc/ssl/corp.pem',
            externalChecksDir: '/home/dev/checks'
        }, path.posix);

        assert.deepStrictEqual(mounts(args), [
            '/work/repo:/checkovScan:ro',
            '/work/repo/infra/.checkov.yaml:/checkovConfig/.checkov.yaml:ro',
            '/etc/ssl/corp.pem:/checkovCert/corp.pem:ro',
            '/home/dev/checks:/checkovExternalChecks/checks:ro'
        ]);
        assert.strictEqual(valueAfter(args, '--config-file'), '/checkovConfig/.checkov.yaml');
        assert.strictEqual(valueAfter(args, '--ca-certificate'), '/checkovCert/corp.pem');
        assert.strictEqual(valueAfter(args, '--external-checks-dir'), '/checkovExternalChecks/checks');
    });

    test('applies the SELinux mode', () => {
        const relabel = buildScanCommand({ ...dockerOptions, selinuxMode: 'relabel' }, path.posix).args;
        const disable = buildScanCommand({ ...dockerOptions, selinuxMode: 'disable' }, path.posix).args;

        assert.deepStrictEqual(mounts(relabel), ['/work/repo:/checkovScan:ro,z']);
        assert.ok(!relabel.includes('label=disable'));
        assert.deepStrictEqual(mounts(disable), ['/work/repo:/checkovScan:ro']);
        assert.strictEqual(valueAfter(disable, '--security-opt'), 'label=disable');
    });

    test('only relabels the workspace folder', () => {
        const outside = buildScanCommand({ ...dockerOptions, selinuxMode: 'relabel', filePath: '/etc/passwd' }, path.posix).args;
        const withCert = buildScanCommand({ ...dockerOptions, selinuxMode: 'relabel', certPath: '/etc/ssl/corp.pem', externalChecksDir: '/home/dev/checks' }, path.posix).args;

        assert.deepStrictEqual(mounts(outside), ['/etc/passwd:/checkovScan/passwd:ro']);
        assert.deepStrictEqual(mounts(withCert), [
            '/work/repo:/checkovScan:ro,z',
            '/etc/ssl/corp.pem:/checkovCert/corp.pem:ro',
            '/home/dev/checks:/checkovExternalChecks/checks:ro'
        ]);
    });

    test('passes frameworks as separate arguments and skip checks as one', () => {
        const { args } = buildScanCommand({
            ...localOptions,
            frameworks: ['terraform', 'secrets'],
            skipFrameworks: ['sca_package'],
            skipChecks: ['BC_LIC*', 'CKV_AWS_1']
        }, path.posix);

        const frameworkIndex = args.indexOf('--framework');
        assert.deepStrictEqual(args.slice(frameworkIndex, frameworkIndex + 3), ['--framework', 'terraform', 'secrets']);
        assert.strictEqual(valueAfter(args, '--skip-framework'), 'sca_package');
        assert.strictEqual(valueAfter(args, '--skip-check'), 'BC_LIC*,CKV_AWS_1');
    });

    test('drops setting values that would be read as options', () => {
        const { args } = buildScanCommand({
            ...localOptions,
            frameworks: ['terraform', '--external-checks-dir', '.'],
            skipChecks: ['--download-external-modules', 'true'],
            repoId: '--config-file=/tmp/x'
        }, path.posix);

        assert.ok(!args.includes('--external-checks-dir'));
        assert.ok(!args.some(arg => arg.includes('--download-external-modules')));
        assert.strictEqual(valueAfter(args, '--repo-id'), 'vscode/default');
    });

    test('omits optional flags when nothing is configured', () => {
        const { args } = buildScanCommand({ ...localOptions, skipChecks: [] }, path.posix);

        for (const flag of ['--framework', '--skip-framework', '--skip-check', '--config-file', '-ca', '--external-checks-dir']) {
            assert.ok(!args.includes(flag), flag);
        }
    });

    test('puts interpreter arguments before the Checkov arguments', () => {
        const { command, args } = buildScanCommand({
            ...localOptions,
            checkovPath: 'C:\\Python313\\python.exe',
            checkovArgs: ['C:\\Python313\\Scripts\\checkov']
        }, path.win32);

        assert.strictEqual(command, 'C:\\Python313\\python.exe');
        assert.deepStrictEqual(args.slice(0, 2), ['C:\\Python313\\Scripts\\checkov', '-f']);
    });
});

suite('sanitiseOptionValues', () => {
    test('trims values and removes empty or dash-prefixed entries', () => {
        assert.deepStrictEqual(sanitiseOptionValues([' terraform ', '', '-x', '--y', 'secrets']), ['terraform', 'secrets']);
        assert.deepStrictEqual(sanitiseOptionValues(undefined), []);
    });
});

suite('parseShebangInterpreter', () => {
    test('reads plain and quoted Windows interpreter paths', () => {
        assert.strictEqual(parseShebangInterpreter('#!C:\\Python313\\python.exe\r\nfrom checkov.main import Checkov'), 'C:\\Python313\\python.exe');
        assert.strictEqual(parseShebangInterpreter('#!"C:\\Program Files\\Python313\\python.exe"\nimport sys'), 'C:\\Program Files\\Python313\\python.exe');
    });

    test('ignores anything that is not an absolute Windows path', () => {
        assert.strictEqual(parseShebangInterpreter('#!/usr/bin/env python\n'), undefined);
        assert.strictEqual(parseShebangInterpreter('#!python\n'), undefined);
        assert.strictEqual(parseShebangInterpreter('from checkov.main import Checkov\n'), undefined);
    });
});

suite('resolveExternalChecksDir', () => {
    const identity = (target: string): string => target;
    const followSymlink = (links: Record<string, string>) => (target: string): string => links[target] ?? target;
    const missing = (): undefined => undefined;

    test('resolves a workspace value against the workspace folder', () => {
        assert.strictEqual(resolveExternalChecksDir(undefined, 'checks', '/work/repo', path.posix, identity), '/work/repo/checks');
        assert.strictEqual(resolveExternalChecksDir('/home/dev/checks', '/work/repo/infra/checks', '/work/repo', path.posix, identity), '/work/repo/infra/checks');
    });

    test('ignores a workspace value that leaves the workspace folder', () => {
        assert.strictEqual(resolveExternalChecksDir(undefined, '../other', '/work/repo', path.posix, identity), undefined);
        assert.strictEqual(resolveExternalChecksDir('/home/dev/checks', '/home/dev/.ssh', '/work/repo', path.posix, identity), '/home/dev/checks');
        assert.strictEqual(resolveExternalChecksDir(undefined, 'D:\\secrets', 'C:\\work\\repo', path.win32, identity), undefined);
    });

    test('ignores a workspace value that is a symlink out of the workspace folder', () => {
        const realPath = followSymlink({ '/work/repo/checks': '/home/dev/.ssh' });

        assert.strictEqual(resolveExternalChecksDir(undefined, 'checks', '/work/repo', path.posix, realPath), undefined);
    });

    test('ignores a workspace value that does not exist', () => {
        assert.strictEqual(resolveExternalChecksDir('/home/dev/checks', 'checks', '/work/repo', path.posix, missing), '/home/dev/checks');
    });

    test('uses the user value when the workspace sets nothing', () => {
        assert.strictEqual(resolveExternalChecksDir('/home/dev/checks', undefined, '/work/repo', path.posix, identity), '/home/dev/checks');
        assert.strictEqual(resolveExternalChecksDir('checks', undefined, '/work/repo', path.posix, identity), '/work/repo/checks');
        assert.strictEqual(resolveExternalChecksDir('checks', undefined, undefined, path.posix, identity), 'checks');
        assert.strictEqual(resolveExternalChecksDir('', undefined, undefined, path.posix, identity), undefined);
    });
});
