import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'winston';
import { CheckovInstallation, CheckovScanRequest } from './checkov/installation';
import { DockerSelinuxMode, resolveExternalChecksDir } from './checkov/scanCommand';
import { fileHashOrUnreadable, hashContent } from './fileHash';
import { configHasSkipCheck, findConfigFiles } from './parseCheckovConfig';

export interface SettingValues<T> {
    globalValue?: T;
    workspaceValue?: T;
    workspaceFolderValue?: T;
}

export interface SettingsReader {
    get<T>(key: string, filePath: string): T | undefined;
    inspect<T>(key: string, filePath: string): SettingValues<T> | undefined;
    workspaceFolder(filePath: string): string | undefined;
}

export type CheckovOptions = Omit<CheckovScanRequest, 'filePath'>;

export interface ScanSettingsSnapshot {
    checkov: CheckovOptions;
    skipPaths: string[];
    minimumSeverity: string;
    fingerprint: string;
}

// results: Checkov's output can differ, so the fingerprint changes.
// rescan: the same results are shown or skipped differently, so cached results can be reused.
// installation: Checkov has to be reinstalled.
export type SettingsChangeEffect = 'results' | 'rescan' | 'installation';

export interface ConfigurationChange {
    affectsConfiguration(section: string): boolean;
}

export type ScanInstallation = Pick<CheckovInstallation, 'method' | 'displayVersion'>;

export interface ScanSettings {
    // Results from one Checkov installation are never reused for another, so the installation is part of the fingerprint.
    resolve(filePath: string, installation: ScanInstallation): ScanSettingsSnapshot;
    classifyChange(change: ConfigurationChange): Set<SettingsChangeEffect>;
}

export interface ScanSettingsDependencies {
    reader: SettingsReader;
    logger: Logger;
}

export const settingsSection = 'checkov-prismaless';

const settingEffects = {
    checkovVersion: 'installation',
    useBridgecrewIDs: 'results',
    certificate: 'results',
    noCertVerify: 'results',
    externalChecksDir: 'results',
    frameworks: 'results',
    skipFrameworks: 'results',
    skipChecks: 'results',
    minimumSeverity: 'rescan',
    skipPaths: 'rescan',
    dockerSelinux: 'rescan',
    useDebugLogs: 'none',
    scanTimeout: 'none',
    maximumConcurrentScans: 'none',
    disableErrorMessage: 'none',
    clearCacheUponConfigUpdate: 'none'
} satisfies Record<string, SettingsChangeEffect | 'none'>;

export type SettingName = keyof typeof settingEffects;

export const settingNames = Object.keys(settingEffects) as SettingName[];

const maximumStampedFiles = 1000;

// Checkov loads external checks from the directory at scan time, so edits to them have to change the fingerprint.
// Python writes compiled files to __pycache__ when it loads them, which would otherwise change it after every first scan.
// Symlinks are followed, and each real directory is walked once so a loop cannot recurse forever.
const directoryStamp = (directory: string): string[] => {
    const stamps: string[] = [];
    const walked = new Set<string>();
    const walk = (current: string): void => {
        let entries: string[];
        try {
            const realDirectory = fs.realpathSync(current);
            if (walked.has(realDirectory)) return;
            walked.add(realDirectory);
            entries = fs.readdirSync(current).sort((a, b) => a.localeCompare(b));
        } catch {
            return;
        }
        for (const name of entries) {
            if (stamps.length >= maximumStampedFiles) return;
            const entryPath = path.join(current, name);
            const relativePath = path.relative(directory, entryPath);
            let stats: fs.Stats;
            try {
                stats = fs.statSync(entryPath);
            } catch {
                stamps.push(`${relativePath}:unreadable`);
                continue;
            }
            if (stats.isDirectory()) {
                if (name !== '__pycache__') walk(entryPath);
            } else if (stats.isFile()) {
                stamps.push(`${relativePath}:${stats.size}:${stats.mtimeMs}`);
            }
        }
    };
    walk(directory);
    return stamps;
};

// These settings are declared as strings, but settings.json can hold anything, so a list is accepted as well.
const toList = (value: unknown): string[] | undefined => {
    const entries: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
    const list = entries.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim());
    return list.length > 0 ? list : undefined;
};

const toSelinuxMode = (value: unknown): DockerSelinuxMode => value === 'relabel' || value === 'disable' ? value : 'off';

export const createScanSettings = ({ reader, logger }: ScanSettingsDependencies): ScanSettings => {
    const read = <T>(name: SettingName, filePath: string): T | undefined => reader.get<T>(name, filePath);
    // A repository's settings could otherwise redirect where Checkov trusts certificates from.
    const readUserOnly = <T>(name: SettingName, filePath: string): T | undefined => reader.inspect<T>(name, filePath)?.globalValue;

    return {
        resolve: (filePath, installation) => {
            const workspaceFolder = reader.workspaceFolder(filePath);
            const externalChecksDir = reader.inspect<string>('externalChecksDir', filePath);
            const configPaths = findConfigFiles(filePath, workspaceFolder);
            // Everything that can change Checkov's output goes here, because the fingerprint is a hash of it.
            const resultOptions: CheckovOptions = {
                workspaceRoot: workspaceFolder,
                configPaths,
                certPath: readUserOnly<string>('certificate', filePath),
                noCertVerify: readUserOnly<boolean>('noCertVerify', filePath) ?? false,
                externalChecksDir: resolveExternalChecksDir(externalChecksDir?.globalValue,
                    externalChecksDir?.workspaceFolderValue ?? externalChecksDir?.workspaceValue, workspaceFolder),
                useBcIds: read<boolean>('useBridgecrewIDs', filePath) ?? false,
                frameworks: toList(read('frameworks', filePath)),
                skipFrameworks: toList(read('skipFrameworks', filePath)),
                // skip-check in a config file takes complete precedence over the setting.
                skipChecks: configHasSkipCheck(configPaths, logger) ? undefined : toList(read('skipChecks', filePath))
            };
            const skipPaths = read<unknown>('skipPaths', filePath);
            return {
                checkov: {
                    ...resultOptions,
                    debugLogs: read<boolean>('useDebugLogs', filePath) ?? false,
                    selinuxMode: toSelinuxMode(read('dockerSelinux', filePath))
                },
                skipPaths: Array.isArray(skipPaths) ? skipPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [],
                minimumSeverity: read<string>('minimumSeverity', filePath) ?? 'None',
                fingerprint: hashContent(JSON.stringify({
                    resultOptions,
                    installation: `${installation.method}:${installation.displayVersion ?? 'unknown'}`,
                    configFiles: configPaths.map(fileHashOrUnreadable),
                    externalChecks: resultOptions.externalChecksDir ? directoryStamp(resultOptions.externalChecksDir) : []
                }))
            };
        },
        classifyChange: change => new Set(settingNames
            .filter(name => change.affectsConfiguration(`${settingsSection}.${name}`))
            .map(name => settingEffects[name])
            .filter((effect): effect is SettingsChangeEffect => effect !== 'none'))
    };
};
