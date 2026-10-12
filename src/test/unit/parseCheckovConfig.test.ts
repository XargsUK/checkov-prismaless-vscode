import * as assert from 'assert';
import * as path from 'path';
import { findConfigFiles } from '../../parseCheckovConfig';

const existing = (...paths: string[]) => (candidate: string): boolean => paths.includes(candidate);

suite('findConfigFiles', () => {
    test('finds a config next to the scanned file, followed by the workspace folder config', () => {
        const exists = existing('/work/repo/terraform/.checkov.yaml', '/work/repo/.checkov.yaml');

        assert.deepStrictEqual(findConfigFiles('/work/repo/terraform/main.tf', '/work/repo', exists, path.posix),
            ['/work/repo/terraform/.checkov.yaml', '/work/repo/.checkov.yaml']);
    });

    test('walks up to the workspace folder and prefers the nearest config', () => {
        const exists = existing('/work/repo/terraform/.checkov.yml', '/work/repo/terraform/modules/.checkov.yaml');

        assert.deepStrictEqual(findConfigFiles('/work/repo/terraform/modules/vpc/main.tf', '/work/repo', exists, path.posix),
            ['/work/repo/terraform/modules/.checkov.yaml']);
    });

    test('falls back to the workspace folder root', () => {
        const exists = existing('/work/repo/.checkov.yaml');

        assert.deepStrictEqual(findConfigFiles('/work/repo/terraform/main.tf', '/work/repo', exists, path.posix), ['/work/repo/.checkov.yaml']);
        assert.deepStrictEqual(findConfigFiles('/work/repo/main.tf', '/work/repo', exists, path.posix), ['/work/repo/.checkov.yaml']);
    });

    test('never looks above the workspace folder', () => {
        const exists = existing('/work/.checkov.yaml', '/.checkov.yaml');

        assert.deepStrictEqual(findConfigFiles('/work/repo/main.tf', '/work/repo', exists, path.posix), []);
    });

    test('ignores files outside the workspace folder', () => {
        const exists = existing('/home/dev/Downloads/.checkov.yaml', '/work/repo/.checkov.yaml');

        assert.deepStrictEqual(findConfigFiles('/home/dev/Downloads/main.tf', '/work/repo', exists, path.posix), []);
        assert.deepStrictEqual(findConfigFiles('/work/repo-other/main.tf', '/work/repo', exists, path.posix), []);
    });

    test('returns nothing when there is no workspace folder', () => {
        const exists = existing('/home/dev/Downloads/.checkov.yaml');

        assert.deepStrictEqual(findConfigFiles('/home/dev/Downloads/main.tf', undefined, exists, path.posix), []);
    });

    test('handles Windows paths', () => {
        const exists = existing('C:\\work\\repo\\templates\\.checkov.yaml');

        assert.deepStrictEqual(findConfigFiles('C:\\work\\repo\\templates\\stack.yml', 'C:\\work\\repo', exists, path.win32),
            ['C:\\work\\repo\\templates\\.checkov.yaml']);
    });
});
