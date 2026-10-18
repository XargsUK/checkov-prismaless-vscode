import * as vscode from 'vscode';
import { Logger } from 'winston';
import { CheckovInstallation, FailedCheckovCheck, installOrUpdateCheckov, runCheckovScan } from './checkov';
import { createFindings, providedCodeActionKinds } from './findings';
import { getLogger, isSupportedFileType, extensionVersion, runVersionCommand, getScanCacheKey, checkovVersionKey } from './utils';
import { initializeStatusBarItem, setErrorStatusBarItem, setFilteredStatusBarItem, setPassedStatusBarItem, setReadyStatusBarItem, setSkippedStatusBarItem, setStatusBarVersion, setSyncingStatusBarItem, showAboutCheckovMessage, showContactUsDetails } from './userInterface';
import { getCheckovVersion, shouldDisableErrorMessage, shouldClearCacheUponConfigUpdate, getPathToCert, getUseBcIds, getUseDebugLogs, getExternalChecksDir, getNoCertVerify, getSkipFrameworks, getFrameworks, getSkipChecks, getMaximumConcurrentScans, getScanTimeout, getSkipPaths, getMinimumSeverity, getDockerSelinuxMode } from './configuration';
import { CLEAR_RESULTS_CACHE, GET_INSTALLATION_DETAILS_COMMAND, INSTALL_OR_UPDATE_CHECKOV_COMMAND, OPEN_CHECKOV_LOG, OPEN_CONFIGURATION_COMMAND, OPEN_EXTERNAL_COMMAND, REFRESH_SEVERITY_MAPPINGS, REMOVE_DIAGNOSTICS_COMMAND, RUN_FILE_SCAN_COMMAND } from './commands';
import { findConfigFiles } from './parseCheckovConfig';
import { clearVersionCache } from './checkov/checkovInstaller';
import { DockerSelinuxMode } from './checkov/scanCommand';
import { createSeverityMappings, githubMappingSource, readBundledMappings } from './severity';
import { createScanLifecycle, ScanOutcome } from './scanLifecycle';
import { clearCache } from './scanCache';

const logFileName = 'checkov.log';

export const CLEAR_VERSION_CACHE = 'checkov-prismaless.clear-version-cache';

type ScanOptions = {
    certPath?: string,
    useBcIds?: boolean,
    debugLogs?: boolean,
    noCertVerify?: boolean,
    externalChecksDir?: string,
    skipFrameworks?: string[],
    frameworks?: string[],
    skipChecks?: string[],
    configPaths: string[],
    selinuxMode?: DockerSelinuxMode
};

const findMatchingSkipPath = (document: vscode.TextDocument): string | undefined => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    return getSkipPaths(document.uri).find(glob =>
        vscode.languages.match({ pattern: workspaceFolder ? new vscode.RelativePattern(workspaceFolder, glob) : glob }, document) > 0);
};

// this method is called when extension is activated
export function activate(context: vscode.ExtensionContext): void {
    const logger: Logger = getLogger(context.logUri.fsPath, logFileName);
    logger.info('Starting Checkov Extension.', { extensionVersion, vscodeVersion: vscode.version });

    let extensionReady = false;

    const rescanActiveDocument = (): void => {
        if (extensionReady && vscode.window.activeTextEditor && isSupportedFileType(vscode.window.activeTextEditor.document.fileName)) {
            vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
        }
    };

    const severityMappings = createSeverityMappings({
        source: githubMappingSource(logger),
        cache: context.globalState,
        bundledMappings: readBundledMappings(vscode.Uri.joinPath(context.extensionUri, 'resources', 'checkov_severity_mappings.json').fsPath, logger),
        logger,
        onMappingsChanged: change => {
            rescanActiveDocument();
            if (change === 'updated') {
                vscode.window.showInformationMessage('Checkov severity mappings updated');
            }
        }
    });
    context.subscriptions.push(severityMappings);

    initializeStatusBarItem(OPEN_CONFIGURATION_COMMAND);
    let checkovInstallation: CheckovInstallation | null = null;
    const checkovInstallationDir = vscode.Uri.joinPath(context.globalStorageUri, 'checkov-installation').fsPath;

    const invokeCheckov = async (filePath: string, options: ScanOptions, signal: AbortSignal): Promise<FailedCheckovCheck[]> => {
        if (!checkovInstallation) {
            throw new Error('Checkov is not installed');
        }
        const tokenSource = new vscode.CancellationTokenSource();
        const onAbort = () => tokenSource.cancel();
        signal.addEventListener('abort', onAbort);
        try {
            const response = await runCheckovScan(logger, checkovInstallation, extensionVersion, filePath, options.certPath, options.useBcIds, options.debugLogs,
                options.noCertVerify, tokenSource.token, options.configPaths, options.externalChecksDir, options.skipFrameworks, options.frameworks,
                options.skipChecks, options.selinuxMode);
            return response.results.failedChecks;
        } finally {
            signal.removeEventListener('abort', onAbort);
            tokenSource.dispose();
        }
    };

    const scanLifecycle = createScanLifecycle<ScanOptions>({
        invoke: invokeCheckov,
        cache: context.workspaceState,
        limits: () => ({ timeoutSeconds: getScanTimeout(), maximumConcurrentScans: getMaximumConcurrentScans() }),
        logger
    });
    context.subscriptions.push({ dispose: () => scanLifecycle.cancelAll() });

    const diagnostics = vscode.languages.createDiagnosticCollection('checkov-alerts');
    context.subscriptions.push(diagnostics);
    const documentFindings = createFindings({ collection: diagnostics, severityMappings });
    context.workspaceState.update('checkovMap', undefined);

    // Set commands
    context.subscriptions.push(
        vscode.commands.registerCommand(INSTALL_OR_UPDATE_CHECKOV_COMMAND, async () => {
            try {
                extensionReady = false;
                setSyncingStatusBarItem('Updating Checkov');
                const checkovVersion = await getCheckovVersion(logger);
                checkovInstallation = await installOrUpdateCheckov(logger, checkovInstallationDir, checkovVersion);
                logger.info('Checkov installation: ', checkovInstallation);

                // Only update version for non-Docker installations
                if (checkovInstallation.checkovInstallationMethod !== 'docker') {
                    checkovInstallation.version = await runVersionCommand(logger, checkovInstallation, checkovVersion);
                }

                const previousCheckovVersion = context.globalState.get(checkovVersionKey);
                if (previousCheckovVersion !== checkovInstallation.version) {
                    logger.info('Previously installed checkov version does not match the newly installed one. Clearing results cache.');
                    context.globalState.update(checkovVersionKey, checkovInstallation.version);
                    clearCache(context.workspaceState, logger);
                } else {
                    logger.debug('Previously installed checkov version matches the newly installed one');
                }

                setStatusBarVersion(checkovInstallation.actualVersion);
                setReadyStatusBarItem();
                extensionReady = true;
                if (vscode.window.activeTextEditor && isSupportedFileType(vscode.window.activeTextEditor?.document.fileName))
                    vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
            } catch (error) {
                setErrorStatusBarItem();
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
                setReadyStatusBarItem();
                documentFindings.clear(vscode.window.activeTextEditor.document.uri);
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
            clearCache(context.workspaceState, logger);
        }),
        vscode.commands.registerCommand(CLEAR_VERSION_CACHE, async () => {
            clearVersionCache();
            logger.info('Checkov version cache cleared');
            vscode.window.showInformationMessage('Checkov version cache cleared');
            // Re-run the installation to get a fresh version
            vscode.commands.executeCommand(INSTALL_OR_UPDATE_CHECKOV_COMMAND);
        }),
        vscode.commands.registerCommand(REFRESH_SEVERITY_MAPPINGS, async () => {
            try {
                logger.info('Manually refreshing severity mappings from GitHub');
                vscode.window.showInformationMessage('Refreshing severity mappings...');
                const result = await severityMappings.refresh();
                if (result === 'updated') {
                    rescanActiveDocument();
                }
                vscode.window.showInformationMessage(result === 'updated' ? 'Checkov severity mappings updated' : 'Checkov severity mappings are already up to date');
            } catch (error) {
                logger.error('Failed to refresh severity mappings', { error });
                vscode.window.showErrorMessage('Failed to refresh severity mappings. Check logs for details.');
            }
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
        vscode.workspace.onDidDeleteFiles(deleteEvent => deleteEvent.files.forEach(uri => documentFindings.clear(uri))),
        vscode.workspace.onDidRenameFiles(renameEvent => renameEvent.files.forEach(({ oldUri }) => documentFindings.clear(oldUri))),
        vscode.workspace.onDidSaveTextDocument(saveEvent => {
            if (!extensionReady) return;
            if ((vscode.window.activeTextEditor && saveEvent.uri.toString() !== vscode.window.activeTextEditor.document.uri.toString())
                || !isSupportedFileType(saveEvent.fileName)) {
                setReadyStatusBarItem();
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
                setReadyStatusBarItem();

                // Cancel all ongoing scans when switching to unsupported files
                scanLifecycle.cancelAll();
                return;
            }
            if (changeViewEvent && changeViewEvent.document.isUntitled) {
                // Ignore untitled documents (e.g. untitled:Untitled-1, etc.), as Checkov requires a file saved to disk.
                // Update the status bar to ready
                setReadyStatusBarItem();
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

            const display_affected = [
                'checkov-prismaless.minimumSeverity',
                'checkov-prismaless.skipPaths'
            ];
            if (display_affected.some(key => event.affectsConfiguration(key))) {
                rescanActiveDocument();
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider([{ pattern: '**/*' }], {
            provideCodeActions: (document, _range, codeActionContext) => documentFindings.codeActions(document, codeActionContext.diagnostics)
        }, { providedCodeActionKinds })
    );

    const startScan = async (fileUri?: vscode.Uri, useCache = false): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        if (!fileUri && editor && !isSupportedFileType(editor.document.fileName, true))
            return;

        const targetUri = fileUri ?? editor?.document.uri;
        if (!targetUri) return;

        const uri = targetUri.toString();
        documentFindings.clear(targetUri);

        if (!fileUri && editor) {
            const skipPattern = findMatchingSkipPath(editor.document);
            if (skipPattern) {
                logger.info(`Not scanning ${editor.document.fileName}: matches "${skipPattern}" in skipPaths`);
                scanLifecycle.cancel(uri);
                setSkippedStatusBarItem(skipPattern);
                return;
            }
        }

        const filePath = targetUri.fsPath;
        const configPaths = findConfigFiles(filePath, vscode.workspace.getWorkspaceFolder(targetUri)?.uri.fsPath);
        let cacheKey: string;
        try {
            cacheKey = getScanCacheKey(filePath, configPaths);
        } catch (error) {
            // hashing fails for unsaved files or output channels
            logger.error('Error occurred while generating file hash', { error });
            scanLifecycle.cancel(uri);
            return;
        }
        logger.debug(configPaths.length > 0 ? `Using Checkov config: ${configPaths.join(', ')}` : 'No Checkov config file found for this file');

        if (isActiveDocument(uri)) {
            setSyncingStatusBarItem('Checkov scanning');
        }
        const outcome = await scanLifecycle.scan({
            uri,
            filePath,
            cacheKey,
            useCache,
            options: {
                certPath: getPathToCert(),
                useBcIds: getUseBcIds(),
                debugLogs: getUseDebugLogs(),
                noCertVerify: getNoCertVerify(),
                externalChecksDir: getExternalChecksDir(targetUri),
                skipFrameworks: getSkipFrameworks(),
                frameworks: getFrameworks(),
                skipChecks: getSkipChecks(),
                configPaths,
                selinuxMode: getDockerSelinuxMode()
            }
        });
        await showScanOutcome(outcome);
    };

    const isActiveDocument = (uri: string): boolean => vscode.window.activeTextEditor?.document.uri.toString() === uri;

    const showUnsuccessfulOutcome = (outcome: Exclude<ScanOutcome, { kind: 'findings' }>): void => {
        const active = isActiveDocument(outcome.uri);
        switch (outcome.kind) {
            case 'cancelled':
                if (active && outcome.reason === 'limit') {
                    setReadyStatusBarItem();
                }
                return;
            case 'timedOut':
                if (active) {
                    setErrorStatusBarItem(`Checkov scan timed out after ${outcome.timeoutSeconds}s`);
                }
                return;
            case 'error':
                logger.error('Error occurred while running a checkov scan', { error: outcome.error });
                if (active) {
                    setErrorStatusBarItem();
                }
                if (!shouldDisableErrorMessage()) {
                    showContactUsDetails(context.logUri, logFileName);
                }
        }
    };

    const showScanOutcome = async (outcome: ScanOutcome): Promise<void> => {
        if (outcome.kind !== 'findings') {
            showUnsuccessfulOutcome(outcome);
            return;
        }

        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(vscode.Uri.parse(outcome.uri));
        } catch (error) {
            logger.warn(`Could not open ${outcome.uri} to show its findings`, { error });
            return;
        }

        const active = isActiveDocument(outcome.uri);
        const total = outcome.findings.length;
        const minimumSeverity = getMinimumSeverity();
        const { hidden } = documentFindings.publish(document, outcome.findings, minimumSeverity);
        logger.debug(`Showing ${total - hidden} of ${total} findings (minimum severity: ${minimumSeverity})`);
        if (!active) return;

        const hiddenMessage = hidden > 0 ? `${hidden} finding${hidden === 1 ? '' : 's'} below ${minimumSeverity} hidden by checkov-prismaless.minimumSeverity` : undefined;
        if (total > hidden) {
            setErrorStatusBarItem(hiddenMessage);
        } else if (hiddenMessage) {
            setFilteredStatusBarItem(hiddenMessage);
        } else {
            setPassedStatusBarItem();
        }
    };
}
