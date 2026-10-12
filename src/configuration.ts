import * as vscode from 'vscode';
import { Logger } from 'winston';
import * as semver from 'semver';
import { isWindows, asyncExecFile } from './utils';
import { DockerSelinuxMode, resolveExternalChecksDir } from './checkov/scanCommand';

const minCheckovVersion = '2.0.0';
const minPythonVersion = '3.7.0';

// These settings are not declared in package.json, so VS Code cannot restrict their scope.
// Reading the user value only stops a workspace from setting them.
const getUserSetting = <T>(key: string): T | undefined =>
    vscode.workspace.getConfiguration('checkov-prismaless').inspect<T>(key)?.globalValue;

export const getPathToCert = (): string | undefined => getUserSetting<string>('certificate');

export const getUseBcIds = (): boolean | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const useBcIds = configuration.get<boolean>('useBridgecrewIDs', false);
    return useBcIds;
};

export const getUseDebugLogs = (): boolean | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const useDebugLogs = configuration.get<boolean>('useDebugLogs', false);
    return useDebugLogs;
};

export const getNoCertVerify = (): boolean | undefined => getUserSetting<boolean>('noCertVerify') ?? false;

// These settings are declared as strings, but settings.json can hold anything, so a list is accepted as well.
const toList = (value: unknown): string[] | undefined => {
    const entries: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
    const list = entries.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim());
    return list.length > 0 ? list : undefined;
};

export const getSkipFrameworks = (): string[] | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    return toList(configuration.get<unknown>('skipFrameworks'));
};

export const getSkipChecks = (): string[] | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    return toList(configuration.get<unknown>('skipChecks'));
};

export const getFrameworks = (): string[] | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    return toList(configuration.get<unknown>('frameworks'));
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

export const verifyPythonVersion = async (logger: Logger, pythonExe = 'python3', args: string[] = ['--version']): Promise<void> => {
    logger.debug(`Getting python version with command: ${pythonExe} ${args.join(' ')}`);
    try {
        const [pythonVersionResponse] = await asyncExecFile(pythonExe, args);
        logger.debug('Raw output:');
        logger.debug(pythonVersionResponse);
        const pythonVersion = pythonVersionResponse.split(' ')[1];
        logger.debug(`Python version: ${pythonVersion}`);
        if (semver.lt(pythonVersion, minPythonVersion)){
            throw Error(`Invalid python version: ${pythonVersion} (must be >=${minPythonVersion})`);
        }
    } catch (error) {
        if (isWindows && pythonExe === 'python3') {
            logger.debug('python3 executable not found on Windows, falling back to python');
            await verifyPythonVersion(logger, 'python');
        } else {
            throw error;
        }
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

export const getExternalChecksDir = (resource: vscode.Uri): string | undefined => {
    const setting = vscode.workspace.getConfiguration('checkov-prismaless', resource).inspect<string>('externalChecksDir');
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath;
    return resolveExternalChecksDir(setting?.globalValue, setting?.workspaceFolderValue ?? setting?.workspaceValue, workspaceFolder);
};

export const getSkipPaths = (resource: vscode.Uri): string[] => {
    const skipPaths = vscode.workspace.getConfiguration('checkov-prismaless', resource).get<unknown>('skipPaths');
    return Array.isArray(skipPaths) ? skipPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
};

export const getMinimumSeverity = (): string => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    return configuration.get<string>('minimumSeverity', 'None');
};

export const getDockerSelinuxMode = (): DockerSelinuxMode => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const mode = configuration.get<string>('dockerSelinux', 'off');
    return mode === 'relabel' || mode === 'disable' ? mode : 'off';
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
