import * as vscode from 'vscode';
import { Logger } from 'winston';
import * as semver from 'semver';
import { SettingsReader, settingsSection } from './scanSettings';

const minCheckovVersion = '2.0.0';

export const vscodeSettingsReader: SettingsReader = {
    get: (key, filePath) => vscode.workspace.getConfiguration(settingsSection, vscode.Uri.file(filePath)).get(key),
    inspect: (key, filePath) => vscode.workspace.getConfiguration(settingsSection, vscode.Uri.file(filePath)).inspect(key),
    workspaceFolder: filePath => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath
};

export const getCheckovVersion = async (logger: Logger): Promise<string> => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const checkovVersion = configuration.get<string>('checkovVersion', 'latest').trim().toLowerCase();

    if (checkovVersion === '' || checkovVersion === 'latest') {
        return 'latest';
    } else {
        logger.debug(`Found version other than "latest" - will attempt to use this: ${checkovVersion}`);
        if (!semver.valid(checkovVersion)) {
            throw Error(`Invalid checkov version: ${checkovVersion}`);
        }
        
        const clean = semver.clean(checkovVersion);
        if (!clean) {
            throw Error(`Invalid checkov version: ${checkovVersion}`);
        }

        if (!semver.satisfies(checkovVersion, `>=${minCheckovVersion}`)) {
            throw Error(`Invalid checkov version: ${checkovVersion} (must be >=${minCheckovVersion})`);
        }

        logger.debug(`Cleaned version: ${clean}`);

        return clean;
    }
};

export const shouldDisableErrorMessage = (): boolean => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const disableErrorMessageFlag = configuration.get<boolean>('disableErrorMessage', false);
    return disableErrorMessageFlag;
};

export const shouldClearCacheUponConfigUpdate = (): boolean => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const clearCacheUponConfigUpdateFlag = configuration.get<boolean>('clearCacheUponConfigUpdate', true);
    return clearCacheUponConfigUpdateFlag;
};

export const getMaximumConcurrentScans = (): number => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const maximumConcurrentScans = configuration.get<number>('maximumConcurrentScans', 2);
    return maximumConcurrentScans;
};

export const getScanTimeout = (): number => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const scanTimeout = configuration.get<number>('scanTimeout', 60);
    return scanTimeout;
};
