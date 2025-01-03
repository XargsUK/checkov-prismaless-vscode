import * as vscode from 'vscode';
import debounce from 'lodash/debounce';
import { Logger } from 'winston';
import { CheckovInstallation, FailedCheckovCheck, installOrUpdateCheckov, runCheckovScan } from './checkov';
import { applyDiagnostics } from './diagnostics';
import { fixCodeActionProvider, providedCodeActionKinds } from './suggestFix';
import { getLogger, saveCheckovResult, isSupportedFileType, extensionVersion, runVersionCommand, getFileHash, saveCachedResults, getCachedResults, clearCache, checkovVersionKey } from './utils';
import { initializeStatusBarItem, setErrorStatusBarItem, setPassedStatusBarItem, setReadyStatusBarItem, setSyncingStatusBarItem, showAboutCheckovMessage, showContactUsDetails } from './userInterface';
import { getCheckovVersion, shouldDisableErrorMessage, getPathToCert, getUseBcIds, getUseDebugLogs, getExternalChecksDir, getNoCertVerify, getSkipFrameworks, getFrameworks } from './configuration';
import { CLEAR_RESULTS_CACHE, GET_INSTALLATION_DETAILS_COMMAND, INSTALL_OR_UPDATE_CHECKOV_COMMAND, OPEN_CHECKOV_LOG, OPEN_CONFIGURATION_COMMAND, OPEN_EXTERNAL_COMMAND, REMOVE_DIAGNOSTICS_COMMAND, RUN_FILE_SCAN_COMMAND } from './commands';
import { getConfigFilePath } from './parseCheckovConfig';
import { clearVersionCache } from './checkov/checkovInstaller';

export const CHECKOV_MAP = 'checkovMap';
const logFileName = 'checkov.log';

export const CLEAR_VERSION_CACHE = 'checkov-prismaless.clear-version-cache';

// this method is called when extension is activated
export function activate(context: vscode.ExtensionContext): void {
    const logger: Logger = getLogger(context.logUri.fsPath, logFileName);
    logger.info('Starting Checkov Extension.', { extensionVersion, vscodeVersion: vscode.version });

    initializeStatusBarItem(OPEN_CONFIGURATION_COMMAND);
    let extensionReady = false;
    let checkovRunCancelTokenSource = new vscode.CancellationTokenSource();
    let checkovInstallation : CheckovInstallation | null = null;
    const checkovInstallationDir = vscode.Uri.joinPath(context.globalStorageUri, 'checkov-installation').fsPath;

    const resetCancelTokenSource = () => {
        checkovRunCancelTokenSource.cancel();
        checkovRunCancelTokenSource.dispose();
        checkovRunCancelTokenSource = new vscode.CancellationTokenSource();
    };

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
                if (vscode.window.activeTextEditor && isSupportedFileType(vscode.window.activeTextEditor.document.fileName))
                    vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
            } catch(error) {
                setErrorStatusBarItem(checkovInstallation?.actualVersion);
                logger.error('Error occurred while preparing Checkov. Verify your settings, or try to reload vscode.', { error });
                !shouldDisableErrorMessage() && showContactUsDetails(context.logUri, logFileName);
            }
        }),
        vscode.commands.registerCommand(RUN_FILE_SCAN_COMMAND, async (fileUri?: vscode.Uri): Promise<void> => {
            if (!extensionReady) {
                logger.warn('Tried to scan before checkov finished installing or updating. Please wait a few seconds and try again.');
                vscode.window.showWarningMessage('Still installing/updating Checkov, please wait a few seconds and try again.', 'Got it');
                return;
            }
            resetCancelTokenSource();
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
            if (!checkovInstallation || !checkovInstallation.version) {
                vscode.window.showWarningMessage("Checkov has not been installed. Try waiting a few seconds or running the 'Install or Update Checkov' command");
            } else {
                await showAboutCheckovMessage(checkovInstallation.version, checkovInstallation.checkovInstallationMethod);
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
            vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
        }),
        vscode.window.onDidChangeActiveTextEditor(changeViewEvent => {
            if (!extensionReady) return;
            if (changeViewEvent && !isSupportedFileType(changeViewEvent.document.fileName)) {
                resetCancelTokenSource();
                setReadyStatusBarItem(checkovInstallation?.actualVersion);
                return;
            }
            vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
        })
    );

    // set code action provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider([{ pattern: '**/*' }],
            fixCodeActionProvider(context.workspaceState), { providedCodeActionKinds: providedCodeActionKinds })
    );

    const startScan = async (fileUri?: vscode.Uri, useCache = false): Promise<void> => {
        resetCancelTokenSource();
        const certPath = getPathToCert();
        const useBcIds = getUseBcIds();
        const debugLogs = getUseDebugLogs();
        const noCertVerify = getNoCertVerify();
        const externalChecksDir = getExternalChecksDir();
        const skipFrameworks = getSkipFrameworks();
        const frameworks = getFrameworks();
        vscode.commands.executeCommand(REMOVE_DIAGNOSTICS_COMMAND);
        if (!fileUri && vscode.window.activeTextEditor && !isSupportedFileType(vscode.window.activeTextEditor.document.fileName, true))
            return;
        if (vscode.window.activeTextEditor) {
            if (useCache) {
                const fileToScan = fileUri?.fsPath || vscode.window.activeTextEditor.document.fileName;
                const hash = getFileHash(fileToScan);
                // fileUri will be non-null if we are scanning a temp (unsaved) file, so use the active editor filename for caching in this case
                const cachedResults = getCachedResults(context, hash, vscode.window.activeTextEditor.document.fileName, logger);
                if (cachedResults) {
                    logger.debug(`Found cached results for file: ${vscode.window.activeTextEditor.document.fileName}, hash: ${hash}`);
                    handleScanResults(fileToScan, vscode.window.activeTextEditor, context.workspaceState, cachedResults.results, logger);
                    return;
                } else {
                    logger.debug(`useCache is true, but did not find cached results for file: ${vscode.window.activeTextEditor.document.fileName}, hash: ${hash}`);
                }
            }
            await runScan(vscode.window.activeTextEditor, certPath, useBcIds, debugLogs, noCertVerify, checkovRunCancelTokenSource.token, externalChecksDir, fileUri, skipFrameworks, frameworks);
        }
    };

    const runScan = debounce(async (editor: vscode.TextEditor, certPath: string | undefined, useBcIds: boolean | undefined, debugLogs: boolean | undefined, noCertVerify: boolean | undefined, cancelToken: vscode.CancellationToken, externalChecksDir: string | undefined, fileUri?: vscode.Uri, skipFrameworks?: string[] | undefined, frameworks?: string[] | undefined): Promise<void> => {
        logger.info('Starting to scan.');
        try {
            setSyncingStatusBarItem(checkovInstallation?.actualVersion, 'Checkov scanning');
            const filePath = fileUri ? fileUri.fsPath : editor.document.fileName;
            const configPath = getConfigFilePath(logger);

            if (!checkovInstallation) {
                logger.error('Checkov is not installed, aborting scan.');
                return;
            }

            const checkovResponse = await runCheckovScan(logger, checkovInstallation, extensionVersion, filePath, certPath, useBcIds, debugLogs, noCertVerify, cancelToken, configPath, externalChecksDir, skipFrameworks, frameworks);
            handleScanResults(filePath, editor, context.workspaceState, checkovResponse.results.failedChecks, logger);
        } catch (error) {
            if (cancelToken.isCancellationRequested) {
                return;
            }

            setErrorStatusBarItem(checkovInstallation?.actualVersion);
            logger.error('Error occurred while running a checkov scan', { error });
            !shouldDisableErrorMessage() && showContactUsDetails(context.logUri, logFileName);
        }
    }, 300, {});

    const handleScanResults = (filename: string, editor: vscode.TextEditor, state: vscode.Memento, checkovFails: FailedCheckovCheck[], logger: Logger) => {
        saveCheckovResult(context.workspaceState, checkovFails);
        applyDiagnostics(editor.document, diagnostics, checkovFails);
        (checkovFails.length > 0 ? setErrorStatusBarItem : setPassedStatusBarItem)(checkovInstallation?.actualVersion);
        saveCachedResults(context, getFileHash(filename), editor.document.fileName, checkovFails, logger);
    };
}
