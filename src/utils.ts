import * as vscode from 'vscode';
import winston from 'winston';
import { fileHash } from './fileHash';
import { showUnsupportedFileMessage } from './userInterface';


const extensionData = vscode.extensions.getExtension('XargsUK.checkov-prismaless');
export const extensionVersion = extensionData ? extensionData.packageJSON.version : 'unknown';

export const checkovVersionKey = 'CKV_VERSION';

const unsupportedExtensions: string[] = ['.log'];
const unsupportedFileNames: string[] = [];

export const isSupportedFileType = (fileName: string, showMessage = false): boolean => {
    const isExtensionNotSupported = unsupportedExtensions.some(extension => fileName.endsWith(extension));
    const isFileNameNotSupported = unsupportedFileNames.some(name => fileName.match(name));
    if (isExtensionNotSupported || isFileNameNotSupported) {
        if (showMessage) {
            showUnsupportedFileMessage();
        }
        return false;
    }
    return true;
};

export const getLogger = (logFileDir: string, logFileName: string): winston.Logger => winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.splat(),
        winston.format.printf(({ level, message, ...rest }) => {
            const logError = rest.error && rest.error instanceof Error ? { error: { ...rest.error, message: rest.error.message, stack: rest.error.stack } } : {};
            const argumentsString = JSON.stringify({ ...rest, ...logError });
            return `[${level}]: ${message} ${argumentsString !== '{}' ? argumentsString : ''}`;
        })
    ),
    transports: [
        new winston.transports.File({
            level: 'debug',
            dirname: logFileDir,
            filename: logFileName
        })
    ]
});

export const getScanCacheKey = (filename: string, settingsFingerprint: string): string =>
    `${fileHash(filename)}:${settingsFingerprint}`;
