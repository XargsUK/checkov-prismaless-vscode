import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import winston from 'winston';
import { createScanSettings, SettingName, settingNames, SettingsReader, settingsSection, SettingValues } from '../../scanSettings';

type Values = Record<string, unknown>;

class InMemorySettings implements SettingsReader {
    readonly user: Values = {};
    readonly workspace: Values = {};
    readonly folders = new Map<string, Values>();

    constructor(folderPaths: string[]) {
        folderPaths.forEach(folder => this.folders.set(folder, {}));
    }

    workspaceFolder(filePath: string): string | undefined {
        return [...this.folders.keys()].find(folder => filePath.startsWith(`${folder}${path.sep}`));
    }

    inspect<T>(key: string, filePath: string): SettingValues<T> {
        const folder = this.workspaceFolder(filePath);
        return {
            globalValue: this.user[key] as T | undefined,
            workspaceValue: this.workspace[key] as T | undefined,
            workspaceFolderValue: folder ? this.folders.get(folder)?.[key] as T | undefined : undefined
        };
    }

    get<T>(key: string, filePath: string): T | undefined {
        const values = this.inspect<T>(key, filePath);
        return values.workspaceFolderValue ?? values.workspaceValue ?? values.globalValue;
    }
}

const logger = winston.createLogger({ silent: true });

suite('scan settings', () => {
    let workspaceFolder: string;
    let filePath: string;
    let settings: InMemorySettings;

    const resolve = (file = filePath) => createScanSettings({ reader: settings, logger }).resolve(file);

    setup(() => {
        workspaceFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-settings-')));
        filePath = path.join(workspaceFolder, 'main.tf');
        fs.writeFileSync(filePath, 'resource "aws_s3_bucket" "b" {}\n');
        settings = new InMemorySettings([workspaceFolder]);
    });

    teardown(() => {
        fs.rmSync(workspaceFolder, { recursive: true, force: true });
    });

    test('changing useBridgecrewIDs changes the fingerprint', () => {
        const before = resolve();
        settings.user.useBridgecrewIDs = true;
        const after = resolve();

        assert.strictEqual(after.checkov.useBcIds, true);
        assert.notStrictEqual(after.fingerprint, before.fingerprint);
    });

    test('changing minimumSeverity keeps the fingerprint and only needs a rescan', () => {
        const before = resolve();
        settings.user.minimumSeverity = 'High';
        const after = resolve();

        assert.strictEqual(after.minimumSeverity, 'High');
        assert.strictEqual(after.fingerprint, before.fingerprint);
        assert.deepStrictEqual([...classify('minimumSeverity')], ['rescan']);
    });

    test('reads certificate settings only from user settings', () => {
        settings.workspace.certificate = '/repo/controlled/ca.pem';
        settings.workspace.noCertVerify = true;
        assert.strictEqual(resolve().checkov.certPath, undefined);
        assert.strictEqual(resolve().checkov.noCertVerify, false);

        settings.user.certificate = '/home/dev/ca.pem';
        settings.user.noCertVerify = true;
        assert.strictEqual(resolve().checkov.certPath, '/home/dev/ca.pem');
        assert.strictEqual(resolve().checkov.noCertVerify, true);
    });

    test('accepts a workspace externalChecksDir only inside the workspace folder', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        fs.mkdirSync(path.join(workspaceFolder, 'checks'));
        try {
            settings.workspace.externalChecksDir = outside;
            assert.strictEqual(resolve().checkov.externalChecksDir, undefined);

            settings.folders.get(workspaceFolder)!.externalChecksDir = 'checks';
            assert.strictEqual(resolve().checkov.externalChecksDir, path.join(workspaceFolder, 'checks'));
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('uses skipChecks unless a config file sets skip-check', () => {
        settings.user.skipChecks = 'BC_LIC*';
        const configPath = path.join(workspaceFolder, '.checkov.yaml');
        fs.writeFileSync(configPath, 'framework:\n  - terraform\n');
        assert.deepStrictEqual(resolve().checkov.configPaths, [configPath]);
        assert.deepStrictEqual(resolve().checkov.skipChecks, ['BC_LIC*']);

        fs.writeFileSync(configPath, 'skip-check:\n  - CKV_AWS_18\n');
        assert.strictEqual(resolve().checkov.skipChecks, undefined);
    });

    test('changing a config file changes the fingerprint', () => {
        const configPath = path.join(workspaceFolder, '.checkov.yaml');
        fs.writeFileSync(configPath, 'framework:\n  - terraform\n');
        const before = resolve();
        fs.writeFileSync(configPath, 'framework:\n  - secrets\n');

        assert.notStrictEqual(resolve().fingerprint, before.fingerprint);
    });

    test('uses each workspace folder\'s own scan settings', () => {
        const otherFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-settings-other-')));
        try {
            settings = new InMemorySettings([workspaceFolder, otherFolder]);
            settings.user.frameworks = 'terraform';
            settings.folders.get(otherFolder)!.frameworks = 'kubernetes';
            settings.folders.get(otherFolder)!.skipChecks = 'CKV_K8S_1';
            settings.folders.get(otherFolder)!.skipPaths = ['charts/**'];

            const other = resolve(path.join(otherFolder, 'deployment.yaml'));
            assert.deepStrictEqual(other.checkov.frameworks, ['kubernetes']);
            assert.deepStrictEqual(other.checkov.skipChecks, ['CKV_K8S_1']);
            assert.deepStrictEqual(other.skipPaths, ['charts/**']);
            assert.strictEqual(other.checkov.workspaceRoot, otherFolder);

            const own = resolve();
            assert.deepStrictEqual(own.checkov.frameworks, ['terraform']);
            assert.strictEqual(own.checkov.skipChecks, undefined);
            assert.deepStrictEqual(own.skipPaths, []);
        } finally {
            fs.rmSync(otherFolder, { recursive: true, force: true });
        }
    });

    test('normalises list settings', () => {
        settings.user.skipChecks = ' CKV_AWS_1,, CKV_AWS_2 \n';
        settings.user.frameworks = ['terraform', ' ', 7, ' secrets '];
        settings.user.skipFrameworks = '';
        settings.user.skipPaths = ['modules/**', '', 3, '  '];

        const snapshot = resolve();
        assert.deepStrictEqual(snapshot.checkov.skipChecks, ['CKV_AWS_1', 'CKV_AWS_2']);
        assert.deepStrictEqual(snapshot.checkov.frameworks, ['terraform', 'secrets']);
        assert.strictEqual(snapshot.checkov.skipFrameworks, undefined);
        assert.deepStrictEqual(snapshot.skipPaths, ['modules/**']);
    });

    test('changing a file in the external checks directory changes the fingerprint', () => {
        const checks = path.join(workspaceFolder, 'checks', 'custom');
        fs.mkdirSync(checks, { recursive: true });
        fs.writeFileSync(path.join(checks, 'BucketCheck.py'), 'class BucketCheck: pass\n');
        settings.user.externalChecksDir = 'checks';
        const before = resolve();
        fs.writeFileSync(path.join(checks, 'BucketCheck.py'), 'class BucketCheck:\n    severity = "HIGH"\n');

        assert.notStrictEqual(resolve().fingerprint, before.fingerprint);
    });

    test('changing checkovVersion needs a reinstall', () => {
        assert.deepStrictEqual([...classify('checkovVersion')], ['installation']);
    });
});

const sampleValues: Record<SettingName, unknown> = {
    checkovVersion: '3.2.0',
    useBridgecrewIDs: true,
    certificate: '/home/dev/ca.pem',
    noCertVerify: true,
    externalChecksDir: '/home/dev/checks',
    frameworks: 'terraform',
    skipFrameworks: 'secrets',
    skipChecks: 'CKV_AWS_1',
    minimumSeverity: 'High',
    skipPaths: ['modules/**'],
    dockerSelinux: 'relabel',
    useDebugLogs: true,
    scanTimeout: 5,
    maximumConcurrentScans: 1,
    disableErrorMessage: true,
    clearCacheUponConfigUpdate: false
};

const contributedSettings = (): Record<string, { scope?: string }> => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    return Object.fromEntries(Object.entries(manifest.contributes.configuration.properties)
        .map(([key, value]) => [key.replace(`${settingsSection}.`, ''), value as { scope?: string }]));
};

suite('scan settings definition', () => {
    test('covers every setting the extension contributes', () => {
        assert.deepStrictEqual(Object.keys(contributedSettings()).filter(name => !settingNames.includes(name as SettingName)), []);
    });

    test('lets each workspace folder set its own scan settings', () => {
        const perFolder = ['externalChecksDir', 'frameworks', 'skipFrameworks', 'skipChecks', 'skipPaths', 'minimumSeverity'];
        const contributed = contributedSettings();

        assert.deepStrictEqual(perFolder.filter(name => contributed[name]?.scope !== 'resource'), []);
    });

    for (const name of settingNames) {
        test(`changing ${name} changes the fingerprint only when it affects results`, () => {
            const workspaceFolder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-settings-')));
            try {
                const filePath = path.join(workspaceFolder, 'main.tf');
                const settings = new InMemorySettings([workspaceFolder]);
                const scanSettings = createScanSettings({ reader: settings, logger });
                const before = scanSettings.resolve(filePath).fingerprint;
                settings.user[name] = sampleValues[name];

                assert.strictEqual(scanSettings.resolve(filePath).fingerprint !== before, classify(name).has('results'));
            } finally {
                fs.rmSync(workspaceFolder, { recursive: true, force: true });
            }
        });
    }
});

const classify = (...changed: string[]) => createScanSettings({ reader: new InMemorySettings([]), logger }).classifyChange({
    affectsConfiguration: section => changed.some(key => section === `checkov-prismaless.${key}`)
});
