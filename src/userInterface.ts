import * as vscode from 'vscode';
import { extensionVersion } from './utils';

export const showContactUsDetails = (logDirectoryPath: vscode.Uri, logFileName: string): void => {
    const contactUsMessage = 'Any troubles? We can help you figure out what happened';

    vscode.window.showInformationMessage(contactUsMessage, 'Open log', 'Open issue', 'Slack us')
        .then(choice => {
            if (!choice) return;

            if (choice === 'Open log') {
                vscode.window.showTextDocument(vscode.Uri.joinPath(logDirectoryPath, logFileName));
                return;
            }

            const uri =
                choice === 'Open issue' ? vscode.Uri.parse('https://github.com/XargsUK/checkov-prismaless-vscode')
                    : vscode.Uri.parse('https://codifiedsecurity.slack.com/');

            vscode.env.openExternal(uri);
        });
};

export const showUnsupportedFileMessage = (): void => {
    const message = 'Unsupported file type for Checkov scanning, We support [Dockerfile, .tf, .yml, .yaml, .json] files only.';
    vscode.window.showWarningMessage(message);
};

export const showAboutCheckovMessage = async (version: string, installationMethod: string): Promise<void> => {
    const message = `Checkov CLI version: ${version}; Installation method: ${installationMethod}; Extension version: ${extensionVersion}`;
    vscode.window.showInformationMessage(message);
};

export const statusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem();

export const initializeStatusBarItem = (onClickCommand: string): void  => {
    statusBarItem.command = onClickCommand;
    statusBarItem.text = 'Checkov';
    statusBarItem.show();
};

const setStatusBarItem = (icon: string, version: string | undefined, text?: string, tooltip?: string): void => {
    statusBarItem.text = getStatusBarText(icon, version, text);
    statusBarItem.tooltip = tooltip;
};

export const setReadyStatusBarItem = (version: string | undefined): void => {
    setStatusBarItem('gear', version);
};

export const setMissingConfigurationStatusBarItem = (version: string | undefined): void => {
    setStatusBarItem('exclude', version);
};

export const setSyncingStatusBarItem = (version: string | undefined, text = 'Checkov'): void => {
    setStatusBarItem('sync~spin', version, text);
};

export const setErrorStatusBarItem = (version: string | undefined, tooltip?: string): void => {
    setStatusBarItem('error', version, undefined, tooltip);
};

export const setPassedStatusBarItem = (version: string | undefined): void => {
    setStatusBarItem('pass', version);
};

export const setSkippedStatusBarItem = (version: string | undefined, pattern: string): void => {
    setStatusBarItem('circle-slash', version, 'Checkov (skipped)', `Not scanned: matches "${pattern}" in checkov-prismaless.skipPaths`);
};

export const setFilteredStatusBarItem = (version: string | undefined, tooltip: string): void => {
    setStatusBarItem('filter', version, 'Checkov (filtered)', tooltip);
};

const getStatusBarText = (icon: string | undefined, version: string | undefined, text = 'Checkov'): string => {
    return `${icon ? `$(${icon}) ` : ''}${text}${version ? ` - v${version}` : ''}`;
};
