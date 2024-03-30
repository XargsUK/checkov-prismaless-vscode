import * as vscode from 'vscode';
import { Logger } from 'winston';
import * as semver from 'semver';
import { asyncExec } from './utils';

const minCheckovVersion = '2.0.0';
const minPythonVersion = '3.7.0';

export const getPathToCert = (): string | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const pathToCert = configuration.get<string>('certificate');
    return pathToCert;
};

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

export const getNoCertVerify = (): boolean | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const noCertVerify = configuration.get<boolean>('noCertVerify', false);
    return noCertVerify;
};

export const getSkipFrameworks = (): string[] | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const skipFrameworks = configuration.get<string>('skipFrameworks');
    return skipFrameworks ? skipFrameworks.split(' ').map(entry => entry.trim()) : undefined;
};

export const getFrameworks = (): string[] | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const frameworks = configuration.get<string>('frameworks');
    return frameworks ? frameworks.split(' ').map(entry => entry.trim()) : undefined;
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

export const verifyPythonVersion = async (logger: Logger, command = 'python3 --version'): Promise<void> => {
    logger.debug(`Getting python version with command: ${command}`);
    const [pythonVersionResponse] = await asyncExec(command);
    logger.debug('Raw output:');
    logger.debug(pythonVersionResponse);
    const pythonVersion = pythonVersionResponse.split(' ')[1];
    logger.debug(`Python version: ${pythonVersion}`);
    if (semver.lt(pythonVersion, minPythonVersion)){
        throw Error(`Invalid python version: ${pythonVersion} (must be >=${minPythonVersion})`);
    }
};

export const shouldDisableErrorMessage = (): boolean => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const disableErrorMessageFlag = configuration.get<boolean>('disableErrorMessage', false);
    return disableErrorMessageFlag;
};

export const getExternalChecksDir = (): string | undefined => {
    const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('checkov-prismaless');
    const externalChecksDir = configuration.get<string>('externalChecksDir');
    return externalChecksDir;
};
