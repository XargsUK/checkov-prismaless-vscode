import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { Logger } from 'winston';
import Docker from 'dockerode';
import { CheckovInstallation } from './checkovInstaller';
import { convertToUnixPath, getGitRepoName, getDockerPathParams, normalizePath } from '../utils';
import { CheckovResponse, CheckovResponseRaw } from './models';
import { parseCheckovResponse } from './checkovParser';

const docker = new Docker();

const dockerMountDir = '/checkovScan';
const configMountDir = '/checkovConfig';
const caMountDir = '/checkovCert';
const externalChecksMountDir = '/checkovExternalChecks';
const skipChecksDefault: string[] = ['BC_LIC*'];

const getDockerFileMountParams = (mountDir: string, filePath: string | undefined): string[] => {
    if (!filePath) {
        return [];
    }

    const [baseName, absPath] = normalizePath(filePath);

    return ['-v', `"${absPath}:${mountDir}/${baseName}"`];
};

const getPathParamsForDockerRun = (mountDir: string, filePath: string | undefined, flag: string): string[][] => {
    const dockerParams = getDockerFileMountParams(mountDir, filePath);
    const checkovParams = filePath ? [flag, `"${mountDir}/${path.basename(filePath)}"`] : [];

    return [dockerParams, checkovParams];
};

const getDockerRunParams = (logger: Logger, workspaceRoot: string | undefined, filePath: string, extensionVersion: string, configFilePath: string | undefined, checkovVersion: string, externalChecksDir: string |undefined, certPath: string | undefined, debugLogs: boolean | undefined, uniqueName: string) => {
    const image = `bridgecrew/checkov:${checkovVersion}`;
    const pathParams = getDockerPathParams(workspaceRoot, filePath);
    // if filepath is within the workspace, then the mount root will be the workspace path, and the file path will be the relative file path from there.
    // otherwise, we will mount into the file's directory, and the file path is just the filename.
    const mountRoot = pathParams[0] || path.dirname(pathParams[1]);
    const filePathToScan = convertToUnixPath(pathParams[0] ? pathParams[1] : path.basename(filePath));
    const debugLogParams = debugLogs ? ['--env', 'LOG_LEVEL=DEBUG'] : [];
    const nameParam = `--name ${uniqueName}`;

    const [caCertDockerParams, caCertCheckovParams] = getPathParamsForDockerRun(caMountDir, certPath, '--ca-certificate');
    const [configFileDockerParams, configFileCheckovParams] = getPathParamsForDockerRun(configMountDir, configFilePath, '--config-file');
    const [externalChecksDockerParams, externalChecksCheckovParams] = getPathParamsForDockerRun(externalChecksMountDir, externalChecksDir, '--external-checks-dir');

    const dockerParams = ['run', '--rm', '--interactive', nameParam, ...debugLogParams, '--env', 'BC_SOURCE=vscode', '--env', `BC_SOURCE_VERSION=${extensionVersion}`,
        '-v', `"${mountRoot}:${dockerMountDir}"`, ...caCertDockerParams, ...configFileDockerParams, ...externalChecksDockerParams, '-w', dockerMountDir];

    return [...dockerParams, image, ...configFileCheckovParams, ...caCertCheckovParams, ...externalChecksCheckovParams, '-f', filePathToScan];
};

const getpipRunParams = (configFilePath: string | undefined) => {
    return configFilePath ? ['--config-file', `"${configFilePath}"`] : [];
};

const cleanupStdout = (stdout: string) => stdout.replace(/.\[0m/g,''); // Clean docker run ANSI escape chars

export const runCheckovScan = (logger: Logger, checkovInstallation: CheckovInstallation, extensionVersion: string, fileName: string,
    certPath: string | undefined, useBcIds: boolean | undefined, debugLogs: boolean | undefined, noCertVerify: boolean | undefined, cancelToken: vscode.CancellationToken,
    configPath: string | undefined, externalChecksDir: string | undefined, skipFrameworks: string[] | undefined, frameworks: string[] | undefined, skipChecks: string[] | undefined): Promise<CheckovResponse> => {
    return new Promise((resolve, reject) => {
        const { checkovInstallationMethod, checkovPath } = checkovInstallation;
        const timestamp = Date.now();
        const uniqueRunName = `vscode-checkov-${timestamp}`;

        // Get the version once and ensure it has a value
        const version = checkovInstallation.version || 'latest';

        // Pass the resolved version to getDockerRunParams
        const dockerRunParams = checkovInstallationMethod === 'docker' ? getDockerRunParams(logger, vscode.workspace.rootPath, fileName, extensionVersion, configPath, version, externalChecksDir, certPath, debugLogs, uniqueRunName) : [];
        const pipRunParams =  ['pipenv', 'pip3'].includes(checkovInstallationMethod) ? getpipRunParams(configPath) : [];
        const filePathParams = checkovInstallationMethod === 'docker' ? [] : ['-f', `"${fileName}"`];
        const certificateParams: string[] = certPath && checkovInstallationMethod !== 'docker' ? ['-ca', `"${certPath}"`] : [];
        const bcIdParam: string[] = useBcIds ? ['--output-bc-ids'] : [];
        const noCertVerifyParam: string[] = noCertVerify ? ['--no-cert-verify'] : [];
        let skipCheckParam: string[] = [];
        if (typeof skipChecks === 'undefined') {
            skipCheckParam = ['--skip-check', skipChecksDefault.join(',')];
        } else if (Array.isArray(skipChecks) && skipChecks.length > 0) {
            skipCheckParam = ['--skip-check', skipChecks.join(',')];
        }
        const externalChecksParams: string[] = externalChecksDir && checkovInstallationMethod !== 'docker' ? ['--external-checks-dir', externalChecksDir] : [];
        const frameworkParams: string[] = frameworks ? ['--framework', frameworks.join(' ')] : [];
        const skipFrameworkParams: string[] = skipFrameworks ? ['--skip-framework', skipFrameworks.join(' ')] : [];
        const workingDir = vscode.workspace.rootPath;
        getGitRepoName(logger, vscode.window.activeTextEditor?.document.fileName).then((repoName) => {
            const repoIdParams = repoName ? ['--repo-id', repoName] : ['--repo-id', 'vscode/default'];
            const checkovArguments: string[] = [...dockerRunParams, ...certificateParams, ...bcIdParam, ...noCertVerifyParam, '-s',
                ...repoIdParams, ...filePathParams, '-o', 'json', ...pipRunParams, ...externalChecksParams, ...frameworkParams, ...skipFrameworkParams, ...skipCheckParam];
            logger.info('Running checkov:');
            logger.info(`${checkovPath} ${checkovArguments.join(' ')}`);

            const debugLogEnv = debugLogs ? { LOG_LEVEL: 'DEBUG' } : {};
            const ckv = spawn(checkovPath, checkovArguments,
                {
                    shell: true,
                    env: { ...process.env, BC_SOURCE: 'vscode', BC_SOURCE_VERSION: extensionVersion, ...debugLogEnv },
                    ...(workingDir ? { cwd: workingDir } : {})
                });

            let stdout = '';

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
                logger.info('Cancellation token invoked, aborting checkov run.', { cancelEvent });
                if (checkovInstallationMethod === 'docker') {
                    const container = docker.getContainer(uniqueRunName);
                    await container.kill().catch(err => {
                        if (err.reason === 'no such container') {
                            logger.info(`not deleting container ${uniqueRunName} as it was already removed`);
                        } else {
                            logger.warn(`failed to delete container ${uniqueRunName}: ${err}`);
                        }
                    });
                } else {
                    ckv.kill('SIGABRT');
                }
            });
        });
    });
};
