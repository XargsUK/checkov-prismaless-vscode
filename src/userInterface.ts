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

let statusBarVersion: string | undefined;

export const setStatusBarVersion = (version: string | undefined): void => {
    statusBarVersion = version;
};

const setStatusBarItem = (icon: string, text?: string, tooltip?: string): void => {
    statusBarItem.text = getStatusBarText(icon, statusBarVersion, text);
    statusBarItem.tooltip = tooltip;
};

export const setReadyStatusBarItem = (): void => {
    setStatusBarItem('gear');
};

export const setSyncingStatusBarItem = (text = 'Checkov'): void => {
    setStatusBarItem('sync~spin', text);
};

export const setErrorStatusBarItem = (tooltip?: string): void => {
    setStatusBarItem('error', undefined, tooltip);
};

export const setPassedStatusBarItem = (): void => {
    setStatusBarItem('pass');
};

export const setSkippedStatusBarItem = (pattern: string): void => {
    setStatusBarItem('circle-slash', 'Checkov (skipped)', `Not scanned: matches "${pattern}" in checkov-prismaless.skipPaths`);
};

export const setFilteredStatusBarItem = (tooltip: string): void => {
    setStatusBarItem('filter', 'Checkov (filtered)', tooltip);
};

const getStatusBarText = (icon: string | undefined, version: string | undefined, text = 'Checkov'): string => {
    return `${icon ? `$(${icon}) ` : ''}${text}${version ? ` - v${version}` : ''}`;
};
