import * as vscode from 'vscode';
import { Logger } from 'winston';
import { FailedCheckovCheck } from './checkov';
import { CheckovInstallation, createCheckovInstaller } from './checkov/installation';
import { nodeProcessHost } from './checkov/processHost';
import { createFindings, providedCodeActionKinds } from './findings';
import { getLogger, isSupportedFileType, extensionVersion, getScanCacheKey, checkovVersionKey } from './utils';
import { initializeStatusBarItem, setErrorStatusBarItem, setFilteredStatusBarItem, setPassedStatusBarItem, setReadyStatusBarItem, setSkippedStatusBarItem, setStatusBarVersion, setSyncingStatusBarItem, showAboutCheckovMessage, showContactUsDetails } from './userInterface';
import { getCheckovVersion, shouldDisableErrorMessage, shouldClearCacheUponConfigUpdate, getMaximumConcurrentScans, getScanTimeout, vscodeSettingsReader } from './configuration';
import { CLEAR_RESULTS_CACHE, GET_INSTALLATION_DETAILS_COMMAND, INSTALL_OR_UPDATE_CHECKOV_COMMAND, OPEN_CHECKOV_LOG, OPEN_CONFIGURATION_COMMAND, OPEN_EXTERNAL_COMMAND, REFRESH_SEVERITY_MAPPINGS, REMOVE_DIAGNOSTICS_COMMAND, RUN_FILE_SCAN_COMMAND } from './commands';
import { createSeverityMappings, githubMappingSource, readBundledMappings } from './severity';
import { createScanLifecycle, ScanOutcome } from './scanLifecycle';
import { clearCache } from './scanCache';
import { CheckovOptions, createScanSettings } from './scanSettings';

const logFileName = 'checkov.log';

export const CLEAR_VERSION_CACHE = 'checkov-prismaless.clear-version-cache';

const findMatchingSkipPath = (document: vscode.TextDocument, skipPaths: string[]): string | undefined => {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    return skipPaths.find(glob =>
        vscode.languages.match({ pattern: workspaceFolder ? new vscode.RelativePattern(workspaceFolder, glob) : glob }, document) > 0);
};

// this method is called when extension is activated
export function activate(context: vscode.ExtensionContext): void {
    const logger: Logger = getLogger(context.logUri.fsPath, logFileName);
    logger.info('Starting Checkov Extension.', { extensionVersion, vscodeVersion: vscode.version });

    let extensionReady = false;
    const scanSettings = createScanSettings({ reader: vscodeSettingsReader, logger });

    const rescanActiveDocument = (): void => {
        if (extensionReady && vscode.window.activeTextEditor && isSupportedFileType(vscode.window.activeTextEditor.document.fileName)) {
            vscode.commands.executeCommand(RUN_FILE_SCAN_COMMAND);
        }
    };

    const severityMappings = createSeverityMappings({
        source: githubMappingSource(logger),
        cache: context.globalState,
        loadBundledMappings: () => readBundledMappings(vscode.Uri.joinPath(context.extensionUri, 'resources', 'checkov_severity_mappings.json').fsPath, logger),
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
    let checkovInstallation: CheckovInstallation | undefined;
    const installer = createCheckovInstaller({
        host: nodeProcessHost,
        logger,
        installationDir: vscode.Uri.joinPath(context.globalStorageUri, 'checkov-installation').fsPath,
        extensionVersion
    });

    const invokeCheckov = async (filePath: string, options: CheckovOptions, signal: AbortSignal): Promise<FailedCheckovCheck[]> => {
        if (!checkovInstallation) {
            throw new Error('Checkov is not installed');
        }
        return checkovInstallation.scan({ ...options, filePath }, signal);
    };

    const scanLifecycle = createScanLifecycle<CheckovOptions>({
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
                checkovInstallation = await installer.install(checkovVersion);
                logger.info('Checkov installation: ', { method: checkovInstallation.method, version: checkovInstallation.displayVersion });

                const previousCheckovVersion = context.globalState.get(checkovVersionKey);
                if (checkovInstallation.displayVersion && previousCheckovVersion !== checkovInstallation.displayVersion) {
                    logger.info('Previously installed checkov version does not match the newly installed one. Clearing results cache.');
                    context.globalState.update(checkovVersionKey, checkovInstallation.displayVersion);
                    clearCache(context.workspaceState, logger);
                } else {
                    logger.debug('Previously installed checkov version matches the newly installed one');
                }

                setStatusBarVersion(checkovInstallation.displayVersion);
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
            if (!checkovInstallation) {
                vscode.window.showWarningMessage(
                    "Checkov has not been installed. Try waiting a few seconds or running the 'Install or Update Checkov' command"
                );
            } else {
                await showAboutCheckovMessage(checkovInstallation.displayVersion ?? 'unknown', checkovInstallation.method);
            }
        }),
        vscode.commands.registerCommand(OPEN_CHECKOV_LOG, async () => {
            vscode.window.showTextDocument(vscode.Uri.joinPath(context.logUri, logFileName));
        }),
        vscode.commands.registerCommand(CLEAR_RESULTS_CACHE, async () => {
            clearCache(context.workspaceState, logger);
        }),
        vscode.commands.registerCommand(CLEAR_VERSION_CACHE, async () => {
            installer.clearVersionCache();
            logger.info('Checkov version cache cleared');
            vscode.window.showInformationMessage('Checkov version cache cleared');
            // Re-run the installation to get a fresh version
            vscode.commands.executeCommand(INSTALL_OR_UPDATE_CHECKOV_COMMAND);
        }),
        vscode.commands.registerCommand(REFRESH_SEVERITY_MAPPINGS, async () => {
            try {
                logger.info('Manually refreshing severity mappings from GitHub');
                vscode.window.showInformationMessage('Refreshing severity mappings...');
                const result = await severityMappings.refresh({ force: true });
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
            const activeUri = vscode.window.activeTextEditor?.document.uri;
            const effects = scanSettings.classifyChange({ affectsConfiguration: section => event.affectsConfiguration(section, activeUri) });
            // Cached results for the old settings can never be served again, so this only frees the space they take.
            if (effects.has('results') && shouldClearCacheUponConfigUpdate()) {
                vscode.commands.executeCommand(CLEAR_RESULTS_CACHE);
            }
            if (effects.has('installation')) {
                // Installing rescans the active document once it finishes.
                vscode.commands.executeCommand(CLEAR_VERSION_CACHE);
            } else if (effects.size > 0) {
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
        if (!checkovInstallation) return;
        const filePath = targetUri.fsPath;
        const settings = scanSettings.resolve(filePath, checkovInstallation);

        if (!fileUri && editor) {
            const skipPattern = findMatchingSkipPath(editor.document, settings.skipPaths);
            if (skipPattern) {
                logger.info(`Not scanning ${editor.document.fileName}: matches "${skipPattern}" in skipPaths`);
                scanLifecycle.cancel(uri);
                setSkippedStatusBarItem(skipPattern);
                return;
            }
        }

        const { configPaths } = settings.checkov;
        let cacheKey: string;
        try {
            cacheKey = getScanCacheKey(filePath, settings.fingerprint);
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
            options: settings.checkov
        });
        await showScanOutcome(outcome, settings.minimumSeverity);
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

    const showScanOutcome = async (outcome: ScanOutcome, minimumSeverity: string): Promise<void> => {
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
