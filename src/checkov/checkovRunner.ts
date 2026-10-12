import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as os from 'os';
import { Logger } from 'winston';
import { CheckovInstallation } from './checkovInstaller';
import { asyncExecFile, getGitRepoName, isWindows } from '../utils';
import { CheckovResponse, CheckovResponseRaw } from './models';
import { parseCheckovResponse } from './checkovParser';
import { configHasSkipCheck } from '../parseCheckovConfig';
import { buildScanCommand, DockerSelinuxMode } from './scanCommand';

const cleanupStdout = (stdout: string) => stdout.replace(/.\[0m/g,''); // Clean docker run ANSI escape chars

export const runCheckovScan = (logger: Logger, checkovInstallation: CheckovInstallation, extensionVersion: string, fileName: string,
    certPath: string | undefined, useBcIds: boolean | undefined, debugLogs: boolean | undefined, noCertVerify: boolean | undefined, cancelToken: vscode.CancellationToken,
    configPaths: string[], externalChecksDir: string | undefined, skipFrameworks: string[] | undefined, frameworks: string[] | undefined, skipChecks: string[] | undefined,
    selinuxMode: DockerSelinuxMode | undefined): Promise<CheckovResponse> => {
    return new Promise((resolve, reject) => {
        const { checkovInstallationMethod, checkovPath, checkovArgs } = checkovInstallation;
        const timestamp = Date.now();
        const uniqueRunName = `vscode-checkov-${timestamp}`;

        // Three-tier hierarchy for skip-check handling:
        // 1. If config file has skip-check, let it handle skip logic entirely
        // 2. If no config file skip-check, use VS Code setting (defaults to BC_LIC*)
        // 3. This allows config files to override VS Code settings completely
        const skipChecksToPass = configHasSkipCheck(configPaths, logger) ? [] : skipChecks;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fileName))?.uri.fsPath;
        // A local Checkov resolves its config and relative paths from the workspace folder.
        // Docker needs no working directory, and nothing should be looked up next to a file outside the workspace.
        const workingDir = checkovInstallationMethod !== 'docker' && workspaceFolder ? workspaceFolder : os.tmpdir();
        getGitRepoName(logger, vscode.window.activeTextEditor?.document.fileName).then((repoName) => {
            const { command, args } = buildScanCommand({
                installationMethod: checkovInstallationMethod,
                checkovPath,
                checkovArgs,
                dockerImageTag: checkovInstallation.version || 'latest',
                containerName: uniqueRunName,
                extensionVersion,
                workspaceRoot: workspaceFolder,
                filePath: fileName,
                repoId: repoName,
                configFilePath: configPaths[0],
                certPath,
                externalChecksDir,
                useBcIds,
                noCertVerify,
                debugLogs,
                frameworks,
                skipFrameworks,
                skipChecks: skipChecksToPass,
                selinuxMode
            });
            logger.info('Running checkov:');
            logger.info(`${command} ${args.join(' ')}`);

            const debugLogEnv = debugLogs ? { LOG_LEVEL: 'DEBUG' } : {};
            const ckv = spawn(command, args,
                {
                    env: { ...process.env, BC_SOURCE: 'vscode', BC_SOURCE_VERSION: extensionVersion, ...debugLogEnv },
                    cwd: workingDir
                });

            let stdout = '';
            let finished = false;

            ckv.stdout.on('data', data => {
                if (data.toString().startsWith('{') || data.toString().startsWith('[') || stdout) {
                    stdout += data;
                } else {
                    logger.debug(`Log from Checkov: ${data}`);
                }
            });

            ckv.stderr.on('data', data => {
                logger.warn(`Checkov stderr: ${data}`);
            });

            ckv.on('error', (error) => {
                logger.error('Error while running Checkov', { error });
            });

            ckv.on('close', code => {
                finished = true;
                try {
                    if (cancelToken.isCancellationRequested) return reject('Cancel invoked');
                    logger.debug(`Checkov scan process exited with code ${code}`);

                    try {
                        const results = JSON.parse(stdout);
                        logger.debug('Checkov task output:');
                        logger.debug(JSON.stringify(results, null, 2));
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    } catch (error) {
                        // JSON parse error is expected in some cases, just log the raw output
                        logger.debug('Checkov task output:', { stdout });
                    }

                    if (code !== 0) return reject(`Checkov exited with code ${code}`);

                    if (stdout.startsWith('[]')) {
                        logger.debug('Got an empty reply from checkov', { reply: stdout, fileName });
                        return resolve({ results: { failedChecks: [] } });
                    }

                    const cleanStdout = cleanupStdout(stdout);
                    const output: CheckovResponseRaw = JSON.parse(cleanStdout);
                    resolve(parseCheckovResponse(output, useBcIds));
                } catch (error) {
                    logger.error('Failed to get response from Checkov.', { error });
                    reject('Failed to get response from Checkov.');
                }
            });

            cancelToken.onCancellationRequested(async (cancelEvent) => {
                if (finished) return;
                logger.info('Cancellation token invoked, aborting checkov run.', { cancelEvent });
                if (checkovInstallationMethod === 'docker') {
                    await asyncExecFile('docker', ['kill', uniqueRunName]).catch(err => {
                        if (/no such container/i.test(String(err))) {
                            logger.info(`not deleting container ${uniqueRunName} as it was already removed`);
                        } else {
                            logger.warn(`failed to delete container ${uniqueRunName}: ${err}`);
                        }
                    });
                } else if (isWindows) {
                    ckv.kill();
                } else {
                    ckv.kill('SIGABRT');
                }
            });
        });
    });
};
