import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { exec, execFile, ExecOptions } from 'child_process';
import winston, { Logger } from 'winston';
import { CheckovInstallation, FailedCheckovCheck } from './checkov';
import { DiagnosticReferenceCode } from './diagnostics';
import { CHECKOV_MAP } from './extension';
import { showUnsupportedFileMessage } from './userInterface';
import * as os from 'os';
import * as path from 'path';
import { getSeverityProvider } from './severityProvider';


const extensionData = vscode.extensions.getExtension('XargsUK.checkov-prismaless');
export const extensionVersion = extensionData ? extensionData.packageJSON.version : 'unknown';

export const isWindows = process.platform === 'win32';

export const checkovVersionKey = 'CKV_VERSION';

const unsupportedExtensions: string[] = ['.log'];
const unsupportedFileNames: string[] = [];

type ExecOutput = [stdout: string, stderr: string];
const shellSafeToken = /^[\w.:/=~-]+$/;

// Runs a command without a shell so arguments are never interpreted.
// On Windows, tools such as pip are often .cmd or .bat shims that only run through cmd.exe,
// so a command made up entirely of plain tokens is still passed to it.
// Windows looks for a bare command name in the working directory before the PATH,
// so commands run from the temp directory unless a caller needs somewhere else.
export const asyncExecFile = async (file: string, args: string[] = [], options: ExecOptions & { input?: string } = {}): Promise<ExecOutput> => {
    const { input, ...rest } = options;
    const execOptions: ExecOptions = { maxBuffer: 1024 * 1000, cwd: os.tmpdir(), ...rest };
    return new Promise((resolve, reject) => {
        const callback = (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
            if (err) { return reject(err); }
            resolve([stdout.toString(), stderr.toString()]);
        };
        const child = isWindows && [file, ...args].every(token => shellSafeToken.test(token))
            ? exec([file, ...args].join(' '), execOptions, callback)
            : execFile(file, args, execOptions, callback);
        if (input !== undefined) {
            child.stdin?.end(input);
        }
    });
};

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

export const saveCheckovResult = (state: vscode.Memento, checkovFails: FailedCheckovCheck[]): void => {
    const checkovMap = checkovFails.reduce((prev, current) => ({
        ...prev,
        [createCheckovKey(current)]: current
    }), []);
    state.update(CHECKOV_MAP, checkovMap);
};

export const createDiagnosticKey = (diagnostic: vscode.Diagnostic): string => {
    let checkId;
    if (typeof(diagnostic.code) === 'string') {
        // code is a custom policy in format: policy_id[:guideline]
        const colonIndex = diagnostic.code.indexOf(':');
        checkId = colonIndex === -1 ? diagnostic.code : diagnostic.code.substring(0, colonIndex);
    } else {
        checkId = (diagnostic.code as DiagnosticReferenceCode).value;
    }
    return `${checkId}-${diagnostic.range.start.line + 1}`;
};
export const createCheckovKey = (checkovFail: FailedCheckovCheck): string => `${checkovFail.checkId}-${checkovFail.fileLineRange[0]}`;

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

export const runVersionCommand = async (logger: winston.Logger, installation: Pick<CheckovInstallation, 'checkovPath' | 'checkovArgs'>, checkovVersion: string | undefined): Promise<string> => {
    const { checkovPath, checkovArgs = [] } = installation;
    const args = checkovPath === 'docker' ? ['run', '--rm', '--interactive', `bridgecrew/checkov:${checkovVersion}`, '-v'] : [...checkovArgs, '-v'];
    logger.debug(`Version command: ${checkovPath} ${args.join(' ')}`);
    const resp = await asyncExecFile(checkovPath, args);
    logger.debug(`Response from version command: ${resp[0]}`);
    return resp[0].trim();
};

export const getGitRepoName = async (logger: winston.Logger, filename: string | undefined): Promise<string | null> => {
    if (!filename) {
        logger.debug('Filename was empty when getting git repo; returning default');
        return null;
    }
    try {
        const output = await asyncExecFile('git', ['-C', path.dirname(filename), 'remote', '-v']);

        if (output[1]) {
            logger.info(`Got stderr output when getting git repo; returning null. Output: ${output[1]}`);
            return null;
        }
        logger.debug(`Output:\n${output[0]}`);

        const lines = output[0].split('\n');

        let firstLine; // we'll save this and come back to it if we don't find 'origin'
        for (const line of lines) {
            if (!firstLine) {
                firstLine = line;
            }
            if (line.startsWith('origin')) {
                // remove the upstream name from the front and ' (fetch)' or ' (push)' from the back
                const repoUrl = line.split('\t')[1].split(' ')[0];
                logger.info('repo url ' + repoUrl);
                const repoName = parseRepoName(repoUrl);
                logger.info('repo name ' + repoName);
                if (repoName) {
                    return repoName;
                }
            }
        }

        // if we're here, then there is no 'origin', so just take the first line as a default (regardless of how many upsteams there happen to be)
        if (firstLine) {
            const repoUrl = firstLine.split('\t')[1].split(' ')[0];
            const repoName = parseRepoName(repoUrl);
            if (repoName) {
                return repoName;
            }
        }

        logger.debug('Did not find any valid repo URL in the "git remote -v" output; returning null');
    } catch (error) {
        logger.debug('git remote -v command failed; returning null', error);
    }
    return null;
};

const parseRepoName = (repoUrl: string): string | null => {
    if (repoUrl.endsWith('/')) {
        repoUrl = repoUrl.substring(0, repoUrl.length - 1);
    }
    const lastSlash = repoUrl.lastIndexOf('/');
    if (lastSlash === -1) {
        return null;
    }
    // / is used in https URLs, and : in git@ URLs
    const priorSlash = repoUrl.lastIndexOf('/', lastSlash - 1);
    const priorColon = repoUrl.lastIndexOf(':', lastSlash - 1);

    if (priorSlash === -1 && priorColon === -1) {
        return null;
    }

    const endsWithDotGit = repoUrl.endsWith('.git');
    const repoName = repoUrl.substring(Math.max(priorSlash, priorColon) + 1, endsWithDotGit ? repoUrl.length - 4 : repoUrl.length);

    // handle VCSes with less standard git remote URLs (uhh, looking at you CodeCommit)
    // example: codecommit::us-west-2://repo_name
    // gets parsed as `/repo_name` and there is no good value to use as the repo "org"
    return repoName.split('/').some(s => s === '') ? null : repoName;
};

export const getFileHash = (filename: string): string => {
    const fileBuffer = fs.readFileSync(filename);
    const hashSum = crypto.createHash('md5');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
};

const getFileHashOrUnreadable = (filename: string): string => {
    try {
        return getFileHash(filename);
    } catch {
        return 'unreadable';
    }
};

// Results depend on the config files as well as the scanned file, so all of them feed the cache key.
export const getScanCacheKey = (filename: string, configPaths: string[]): string =>
    [getFileHash(filename), ...configPaths.map(getFileHashOrUnreadable)].join(':');

/**
 * Loads severity mappings using the GitHub-based severity provider
 */
export const loadSeverityMappings = (logger?: Logger): void => {
    const provider = getSeverityProvider();

    if (logger) {
        logger.debug('Loading severity mappings using GitHub-based provider');
    }

    // Check if provider is initialized and has mappings
    const stats = provider.getStatistics();
    if (stats.totalMappings > 0) {
        if (logger) {
            logger.debug(`Severity provider initialized with ${stats.totalMappings} mappings (version: ${stats.version})`);
            logger.debug(`Last updated: ${stats.lastUpdate}`);
        }
    } else {
        if (logger) {
            logger.warn('Severity provider not initialized or has no mappings');
        }
    }
};

/**
 * Gets the severity for a given Checkov check ID using the GitHub-based severity provider
 * @param checkId The Checkov check ID (e.g., "CKV_AWS_1")
 * @returns The severity string, or undefined if the check is not in the mappings
 */
export const getSeverityForCheckId = (checkId: string, logger?: Logger): string | undefined => {
    const provider = getSeverityProvider();
    const severity = provider.getSeverity(checkId);
    
    if (severity) {
        if (logger) {
            logger.debug(`Severity lookup for ${checkId}: ${severity} (from GitHub provider)`);
        }
        return severity;
    }
    
    if (logger) {
        logger.debug(`Severity lookup for ${checkId}: not found in mappings (from GitHub provider)`);
    }

    return undefined;
};

/**
 * Maps Checkov severity strings to VS Code diagnostic severity levels
 * @param severity The Checkov severity string
 * @returns The corresponding VS Code DiagnosticSeverity
 */
export const mapSeverityToVSCode = (severity: string): vscode.DiagnosticSeverity => {
    switch (severity.toUpperCase()) {
        case 'CRITICAL':
        case 'HIGH':
            return vscode.DiagnosticSeverity.Error;
        case 'MEDIUM':
            return vscode.DiagnosticSeverity.Warning;
        case 'LOW':
        case 'INFO':
            return vscode.DiagnosticSeverity.Information;
        case 'UNKNOWN':
        default:
            return vscode.DiagnosticSeverity.Warning; // fallback for unknown severities
    }
};
