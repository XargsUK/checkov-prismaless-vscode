import * as vscode from 'vscode';
import debounce from 'lodash/debounce';
import { Logger } from 'winston';
import { CheckovInstallation, FailedCheckovCheck, installOrUpdateCheckov, runCheckovScan } from './checkov';
import { applyDiagnostics } from './diagnostics';
import { fixCodeActionProvider, providedCodeActionKinds } from './suggestFix';
import { getLogger, saveCheckovResult, isSupportedFileType, extensionVersion, runVersionCommand, getFileHash, saveCachedResults, getCachedResults, clearCache, checkovVersionKey } from './utils';
import { initializeStatusBarItem, setErrorStatusBarItem, setPassedStatusBarItem, setReadyStatusBarItem, setSyncingStatusBarItem, showAboutCheckovMessage, showContactUsDetails } from './userInterface';
import { getCheckovVersion, shouldDisableErrorMessage, shouldClearCacheUponConfigUpdate, getPathToCert, getUseBcIds, getUseDebugLogs, getExternalChecksDir, getNoCertVerify, getSkipFrameworks, getFrameworks, getSkipChecks, getMaximumConcurrentScans, getScanTimeout } from './configuration';
import { CLEAR_RESULTS_CACHE, GET_INSTALLATION_DETAILS_COMMAND, INSTALL_OR_UPDATE_CHECKOV_COMMAND, OPEN_CHECKOV_LOG, OPEN_CONFIGURATION_COMMAND, OPEN_EXTERNAL_COMMAND, REMOVE_DIAGNOSTICS_COMMAND, RUN_FILE_SCAN_COMMAND } from './commands';
import { getConfigFilePath } from './parseCheckovConfig';
import { clearVersionCache } from './checkov/checkovInstaller';

export const CHECKOV_MAP = 'checkovMap';
const logFileName = 'checkov.log';

export const CLEAR_VERSION_CACHE = 'checkov-prismaless.clear-version-cache';

type RunScanOptions = {
  certPath?: string,
  useBcIds?: boolean,
  debugLogs?: boolean,
  noCertVerify?: boolean,
  cancelToken: vscode.CancellationToken,
  externalChecksDir?: string,
  fileUri?: vscode.Uri,
  skipFrameworks?: string[],
  frameworks?: string[],
  skipChecks?: string[]
};

// Track active scan tokens with document URI for better management
interface ActiveScan {
    uri: string;
    tokenSource: vscode.CancellationTokenSource;
}

// this method is called when extension is activated
export function activate(context: vscode.ExtensionContext): void {
    const logger: Logger = getLogger(context.logUri.fsPath, logFileName);
    logger.info('Starting Checkov Extension.', { extensionVersion, vscodeVersion: vscode.version });

    const activeScanTokens: ActiveScan[] = [];
    initializeStatusBarItem(OPEN_CONFIGURATION_COMMAND);
    let extensionReady = false;
    let checkovInstallation: CheckovInstallation | null = null;
    const checkovInstallationDir = vscode.Uri.joinPath(context.globalStorageUri, 'checkov-installation').fsPath;
    const MAX_CONCURRENT_SCANS = getMaximumConcurrentScans();

    // Set diagnostics collection
    const diagnostics = vscode.languages.createDiagnosticCollection('checkov-alerts');
    context.subscriptions.push(diagnostics);

    // Set commands
    context.subscriptions.push(
        vscode.commands.registerCommand(INSTALL_OR_UPDATE_CHECKOV_COMMAND, async () => {
            try {
                extensionReady = false;
                setSyncingStatusBarItem(checkovInstallation?.actualVersion, 'Updating Checkov');
                const checkovVersion = await getCheckovVersion(logger);
                checkovInstallation = await installOrUpdateCheckov(logger, checkovInstallationDir, checkovVersion);
                logger.info('Checkov installation: ', checkovInstallation);

                // Only update version for non-Docker installations
                if (checkovInstallation.checkovInstallationMethod !== 'docker') {
                    checkovInstallation.version = await runVersionCommand(logger, checkovInstallation.checkovPath, checkovVersion);
                }

                const previousCheckovVersion = context.globalState.get(checkovVersionKey);
                if (previousCheckovVersion !== checkovInstallation.version) {
                    logger.info('Previously installed checkov version does not match the newly installed one. Clearing results cache.');
                    context.globalState.update(checkovVersionKey, checkovInstallation.version);
                    clearCache(context, logger);
                } else {
                    logger.debug('Previously installed checkov version matches the newly installed one');
                }

                setReadyStatusBarItem(checkovInstallation.actualVersion);
                extensionReady = true;
                if (vscode.window.activeTextEditor && isSupportedFileType(vscode.window.activeTextEditor?.document.fileName))
                    vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
            } catch (error) {
                setErrorStatusBarItem(checkovInstallation?.actualVersion);
                logger.error('Error occurred while preparing Checkov. Verify your settings, or try to reload vscode.', { error });
                if (!shouldDisableErrorMessage()) {
                    showContactUsDetails(context.logUri, logFileName);
                }
            }
        }),
        vscode.commands.registerCommand(RUN_FILE_SCAN_COMMAND, async (fileUri?: vscode.Uri): Promise<void> => {
            if (!extensionReady) {
                logger.warn('Tried to scan before checkov finished installing or updating. Please wait a few seconds and try again.');
                vscode.window.showWarningMessage('Still installing/updating Checkov, please wait a few seconds and try again.', 'Got it');
                return;
            }
            await startScan(fileUri, true);
        }),
        vscode.commands.registerCommand(REMOVE_DIAGNOSTICS_COMMAND, () => {
            if (vscode.window.activeTextEditor) {
                setReadyStatusBarItem(checkovInstallation?.actualVersion);
                applyDiagnostics(vscode.window.activeTextEditor.document, diagnostics, []);
            }
        }),
        vscode.commands.registerCommand(OPEN_CONFIGURATION_COMMAND, () => {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:XargsUK.checkov-prismaless');
        }),
        vscode.commands.registerCommand(OPEN_EXTERNAL_COMMAND, (uri: vscode.Uri) => vscode.env.openExternal(uri)),
        vscode.commands.registerCommand(GET_INSTALLATION_DETAILS_COMMAND, async () => {
            if (!checkovInstallation?.version) {
                vscode.window.showWarningMessage(
                    "Checkov has not been installed. Try waiting a few seconds or running the 'Install or Update Checkov' command"
                );
            } else {
                await showAboutCheckovMessage(
                    checkovInstallation.version,
                    checkovInstallation.checkovInstallationMethod
                );
            }
        }),
        vscode.commands.registerCommand(OPEN_CHECKOV_LOG, async () => {
            vscode.window.showTextDocument(vscode.Uri.joinPath(context.logUri, logFileName));
        }),
        vscode.commands.registerCommand(CLEAR_RESULTS_CACHE, async () => {
            clearCache(context, logger);
        }),
        vscode.commands.registerCommand(CLEAR_VERSION_CACHE, async () => {
            clearVersionCache();
            logger.info('Checkov version cache cleared');
            vscode.window.showInformationMessage('Checkov version cache cleared');
            // Re-run the installation to get a fresh version
            vscode.commands.executeCommand(INSTALL_OR_UPDATE_CHECKOV_COMMAND);
        })
    );

    vscode.commands.executeCommand(INSTALL_OR_UPDATE_CHECKOV_COMMAND);

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(changeEvent => {
            if (!extensionReady) return;
            if ((vscode.window.activeTextEditor &&
                changeEvent.document.uri.toString() !== vscode.window.activeTextEditor.document.uri.toString())
                || !isSupportedFileType(changeEvent.document.fileName))
                return;
            vscode.commands.executeCommand(REMOVE_DIAGNOSTICS_COMMAND);
        }),
        vscode.workspace.onDidSaveTextDocument(saveEvent => {
            if (!extensionReady) return;
            if ((vscode.window.activeTextEditor && saveEvent.uri.toString() !== vscode.window.activeTextEditor.document.uri.toString())
                || !isSupportedFileType(saveEvent.fileName)) {
                setReadyStatusBarItem(checkovInstallation?.actualVersion);
                return;
            }
            if ((saveEvent.fileName.endsWith('.checkov.yaml') || saveEvent.fileName.endsWith('.checkov.yml')) && shouldClearCacheUponConfigUpdate()) {
                vscode.commands.executeCommand(CLEAR_RESULTS_CACHE);
            }
            vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
        }),
        vscode.window.onDidChangeActiveTextEditor(changeViewEvent => {
            if (!extensionReady) return;
            if (changeViewEvent && (!isSupportedFileType(changeViewEvent.document.fileName) || changeViewEvent.document.uri.toString().startsWith('output:'))) {
                // Ignore unsupported files and output channels (e.g. output:exthost, output:ptyhost, etc.)
                setReadyStatusBarItem(checkovInstallation?.actualVersion);

                // Cancel all ongoing scans when switching to unsupported files
                cancelAllActiveScans();
                return;
            }
            if (changeViewEvent && changeViewEvent.document.isUntitled) {
                // Ignore untitled documents (e.g. untitled:Untitled-1, etc.), as Checkov requires a file saved to disk.
                // Update the status bar to ready
                setReadyStatusBarItem(checkovInstallation?.actualVersion);
                return;
            }
            vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!extensionReady) return;
            const cache_affected = [
                'checkov-prismaless.skipFrameworks',
                'checkov-prismaless.frameworks',
                'checkov-prismaless.skipChecks'
            ];
            if (cache_affected.some(key => event.affectsConfiguration(key)) && shouldClearCacheUponConfigUpdate()) {
                vscode.commands.executeCommand(CLEAR_RESULTS_CACHE);
            }

            const version_affected = [
                'checkov-prismaless.checkovVersion',
            ];
            if (version_affected.some(key => event.affectsConfiguration(key)) && shouldClearCacheUponConfigUpdate()) {
                vscode.commands.executeCommand(CLEAR_VERSION_CACHE);
            }
        })
    );

    // set code action provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider([{ pattern: '**/*' }],
            fixCodeActionProvider(context.workspaceState), { providedCodeActionKinds: providedCodeActionKinds })
    );

    const startScan = async (fileUri?: vscode.Uri, useCache = false): Promise<void> => {
        // Remove diagnostics before starting a new scan
        vscode.commands.executeCommand(REMOVE_DIAGNOSTICS_COMMAND);

        // Check if file is supported
        if (!fileUri && vscode.window.activeTextEditor && !isSupportedFileType(vscode.window.activeTextEditor?.document.fileName, true))
            return;

        if (!vscode.window.activeTextEditor) return;

        const documentUri = fileUri?.toString() || vscode.window.activeTextEditor.document.uri.toString();

        // Cancel any existing scan for this document
        cancelScanForDocument(documentUri);

        // Create a new cancellation token source
        const tokenSource = new vscode.CancellationTokenSource();
        const scanTimeout = getScanTimeout();

        // Automatically cancel the scan after timeout
        setTimeout(() => {
            if (!tokenSource.token.isCancellationRequested) {
                logger.debug(`Cancelling scan for ${documentUri} due to timeout (${scanTimeout}s)`);
                tokenSource.cancel();
            }
        }, scanTimeout * 1000);

        // Add to active scans tracking
        activeScanTokens.push({
            uri: documentUri,
            tokenSource: tokenSource
        });

        // Enforce maximum concurrent scans limit
        if (activeScanTokens.length > MAX_CONCURRENT_SCANS) {
            // Find and cancel oldest scan(s) until we're within limits
            while (activeScanTokens.length > MAX_CONCURRENT_SCANS) {
                const oldestScan = activeScanTokens.shift();
                if (oldestScan) {
                    logger.info(`Canceling scan of ${oldestScan.uri} due to concurrent scan limit`);
                    oldestScan.tokenSource.cancel();
                    oldestScan.tokenSource.dispose(); // Dispose to prevent memory leaks
                }
            }
        }

        if (useCache) {
            const fileToScan = fileUri?.fsPath ?? vscode.window.activeTextEditor.document.fileName;
            let hash: string;
            try {
                hash = getFileHash(fileToScan);
            } catch (error) {
                // getFileHash fails for unsaved files or output channels
                logger.error('Error occurred while generating file hash', { error });
                removeScanToken(documentUri);
                return;
            }
            const cachedResults = getCachedResults(context, hash, vscode.window.activeTextEditor.document.fileName, logger);
            if (cachedResults) {
                logger.debug(`Found cached results for file: ${vscode.window.activeTextEditor.document.fileName}, hash: ${hash}`);
                handleScanResults(fileToScan, vscode.window.activeTextEditor, context.workspaceState, cachedResults.results, logger);
                removeScanToken(documentUri);
                return;
            } else {
                logger.debug(`useCache is true, but did not find cached results for file: ${vscode.window.activeTextEditor.document.fileName}, hash: ${hash}`);
            }
        }

        const certPath = getPathToCert();
        const useBcIds = getUseBcIds();
        const debugLogs = getUseDebugLogs();
        const noCertVerify = getNoCertVerify();
        const externalChecksDir = getExternalChecksDir();
        const skipFrameworks = getSkipFrameworks();
        const skipChecks = getSkipChecks();
        const frameworks = getFrameworks();

        try {
            await runScan(vscode.window.activeTextEditor, {
                certPath,
                useBcIds,
                debugLogs,
                noCertVerify,
                cancelToken: tokenSource.token,
                externalChecksDir,
                fileUri,
                skipFrameworks,
                frameworks,
                skipChecks
            });
        } finally {
            // Always clean up the token when scan completes (success or failure)
            removeScanToken(documentUri);
        }
    };

    /**
     * Cancels an existing scan for a specific document URI
     */
    const cancelScanForDocument = (documentUri: string): void => {
        const index = activeScanTokens.findIndex(item => item.uri === documentUri);
        if (index !== -1) {
            const scan = activeScanTokens[index];
            logger.debug(`Canceling existing scan for ${documentUri}`);
            scan.tokenSource.cancel();
            scan.tokenSource.dispose(); // Dispose to prevent memory leaks
            activeScanTokens.splice(index, 1); // Remove from tracking array
        }
    };

    /**
     * Removes a scan token from the active scans tracking
     */
    const removeScanToken = (documentUri: string): void => {
        const index = activeScanTokens.findIndex(item => item.uri === documentUri);
        if (index !== -1) {
            const scan = activeScanTokens[index];
            // Only dispose if it hasn't been canceled already
            if (!scan.tokenSource.token.isCancellationRequested) {
                scan.tokenSource.dispose();
            }
            activeScanTokens.splice(index, 1);
        }
    };

    /**
     * Cancels all active scans
     */
    const cancelAllActiveScans = (): void => {
        logger.debug(`Canceling all ${activeScanTokens.length} active scans`);

        // Create a copy of the array since we'll be modifying it during iteration
        const scansToCancel = [...activeScanTokens];

        // Cancel and dispose each scan
        for (const scan of scansToCancel) {
            logger.debug(`Canceling scan for ${scan.uri}`);
            scan.tokenSource.cancel();
            scan.tokenSource.dispose();
        }

        // Clear the array
        activeScanTokens.length = 0;
    };

    const runScan = debounce(async (
        editor: vscode.TextEditor,
        options: RunScanOptions
    ) => {        logger.info('Starting to scan.');
        try {
            setSyncingStatusBarItem(checkovInstallation?.actualVersion, 'Checkov scanning');
            const filePath = options.fileUri ? options.fileUri.fsPath : editor.document.fileName;
            const configPath = getConfigFilePath(logger);

            if (!checkovInstallation) {
                logger.error('Checkov is not installed, aborting scan.');
                return;
            }

            const checkovResponse = await runCheckovScan(logger, checkovInstallation, extensionVersion, filePath, options.certPath, options.useBcIds, options.debugLogs, options.noCertVerify, options.cancelToken, configPath, options.externalChecksDir, options.skipFrameworks, options.frameworks, options.skipChecks);            handleScanResults(filePath, editor, context.workspaceState, checkovResponse.results.failedChecks, logger);
        } catch (error) {
            if (options.cancelToken.isCancellationRequested) {
                return;
            }

            setErrorStatusBarItem(checkovInstallation?.actualVersion);
            logger.error('Error occurred while running a checkov scan', { error });
            if (!shouldDisableErrorMessage()) {
                showContactUsDetails(context.logUri, logFileName);
            }
        }
    }, 100, {});

    const handleScanResults = (filename: string, editor: vscode.TextEditor, state: vscode.Memento, checkovFails: FailedCheckovCheck[], logger: Logger) => {
        saveCheckovResult(context.workspaceState, checkovFails);
        applyDiagnostics(editor.document, diagnostics, checkovFails);
        (checkovFails.length > 0 ? setErrorStatusBarItem : setPassedStatusBarItem)(checkovInstallation?.actualVersion);
        saveCachedResults(context, getFileHash(filename), editor.document.fileName, checkovFails, logger);
    };
}
