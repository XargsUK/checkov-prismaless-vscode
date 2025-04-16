import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from 'winston';
import { asyncExec, isWindows } from '../utils';
import { verifyPythonVersion } from '../configuration';

const isPipCheckovInstalledGlobally = async () => {
    try {
        await asyncExec('checkov --version');
        return true;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
        // We expect this error if checkov is not installed
        return false;
    }
};

const getPipCheckovExecutablePath = async (logger: Logger): Promise<string> => {
    if (!isWindows) {
        const [pythonUserBaseOutput] = await asyncExec('python3 -c "import site; print(site.USER_BASE)"');
        logger.debug(`User base output: ${pythonUserBaseOutput}`);
        return path.join(pythonUserBaseOutput.trim(), 'bin', 'checkov');
    } else {
        // Windows has issues with the approach above (no surprise), but we can get to site-packages and from there to the executable
        const [showCheckovOutput] = await asyncExec('pip3 show checkov');
        for (const line of showCheckovOutput.split(os.EOL)) {
            if (line.startsWith('Location: ')) {
                logger.debug(line);
                const sitePackagePath = line.split(' ')[1];
                return path.join(path.dirname(sitePackagePath), 'Scripts', 'checkov');
            }
        }
    }

    throw new Error('Failed to find the path to the non-global checkov executable');
};

const installOrUpdateCheckovWithPip3 = async (logger: Logger, checkovVersion: string): Promise<string | null> => {
    logger.info('Trying to install Checkov using pip3.');

    let firstTry = true;
    let pythonExe = 'python3';
    let pipExe = 'pip3';

    while (true) {
        try {
            await verifyPythonVersion(logger, `${pythonExe} --version`);
            const command = `${pipExe} install --user -U -i https://pypi.org/simple/ checkov${checkovVersion === 'latest' ? '' : `==${checkovVersion}`}`;
            logger.debug(`Testing pip[3] installation with command: ${command}`);
            await asyncExec(command);

            let checkovPath;
            if (await isPipCheckovInstalledGlobally()) {
                checkovPath = 'checkov';
            } else {
                checkovPath = await getPipCheckovExecutablePath(logger);
            }
            logger.info(`Checkov installed successfully using ${pipExe}.`, { checkovPath });
            return checkovPath;
        } catch (error) {
            logger.error(`Failed to install or update Checkov using ${pipExe}. Error:`, { error });
            if (firstTry) {
                logger.info('Retrying using `python` and `pip`');
                pythonExe = 'python';
                pipExe = 'pip';
                firstTry = false;
            } else {
                return null;
            }
        }
    }
};

const getPipenvPythonExecutableLocation = async (logger: Logger, cwd: string): Promise<string> => {
    const getExeCommand = isWindows ? 'pipenv run where python': 'pipenv run which python';
    logger.debug(`Getting pipenv executable with command: ${getExeCommand}`);
    const [execOutput] = await asyncExec(getExeCommand, { cwd });

    if (!isWindows) {
        return execOutput;
    } else {
        return execOutput.split(os.EOL)[0]; // Windows returns all results from the path
    }
};

const installOrUpdateCheckovWithPipenv = async (logger: Logger, installationDir: string, checkovVersion: string): Promise<string | null> => {

    logger.info('Trying to install Checkov using pipenv.');

    try {
        fs.mkdirSync(installationDir, { recursive: true });
        logger.debug(`Installation dir: ${installationDir}`);
        const installCommand = `pipenv --python 3 install checkov${checkovVersion && checkovVersion.toLowerCase() !== 'latest' ? `==${checkovVersion}` : '~=2.0.0'}`;
        await verifyPythonVersion(logger, 'pipenv run python --version');
        logger.debug(`Testing pipenv installation with command: ${installCommand}`);
        await asyncExec(installCommand, { cwd: installationDir });

        const execOutput = await getPipenvPythonExecutableLocation(logger, installationDir);
        logger.debug(`pipenv python executable: ${execOutput}`);

        const checkovPath = `"${path.join(path.dirname(execOutput), 'checkov')}"`;
        logger.info('Checkov installed successfully using pipenv.', { checkovPath, installationDir });
        return checkovPath;
    } catch (error) {
        logger.error('Failed to install or update Checkov using pipenv. Error:', { error });
        return null;
    }
};

interface VersionCache {
    version: string;
    timestamp: number;
    resolvedVersion: string;  // The version to use in Docker commands
}

let versionCache: VersionCache | null = null;
const VERSION_CACHE_TTL = 1000 * 60 * 60; // 1 hour

const checkVersionHasDockerTag = async (version: string, logger: Logger): Promise<boolean> => {
    try {
        await asyncExec(`docker pull bridgecrew/checkov:${version}`);
        return true;
    } catch (error) {
        logger.debug(`Version ${version} does not have a corresponding Docker tag`, { error });
        return false;
    }
};

const resolveCheckovVersion = async (logger: Logger, requestedVersion: string): Promise<{ version: string, resolvedVersion: string }> => {
    // If a specific version is requested, use it directly
    if (requestedVersion !== 'latest') {
        return { version: requestedVersion, resolvedVersion: requestedVersion };
    }

    // For 'latest', check cache first
    const now = Date.now();
    if (versionCache && (now - versionCache.timestamp) < VERSION_CACHE_TTL) {
        return { version: versionCache.version, resolvedVersion: versionCache.resolvedVersion };
    }

    try {
        // First pull latest to get the current version number
        await asyncExec('docker pull bridgecrew/checkov:latest');
        const [versionOutput] = await asyncExec('docker run --rm --interactive bridgecrew/checkov:latest -v');
        const version = versionOutput.trim();

        // Check if this specific version has a Docker tag
        const hasDockerTag = await checkVersionHasDockerTag(version, logger);

        // If the version has a tag, use it; otherwise use latest
        const resolvedVersion = hasDockerTag ? version : 'latest';
        if (hasDockerTag) {
            logger.info(`Using specific version tag: ${version}`);
        } else {
            logger.info(`Version ${version} not available as tag, using latest`);
        }

        // Cache both versions
        versionCache = { version, resolvedVersion, timestamp: now };
        return { version, resolvedVersion };
    } catch (error) {
        logger.warn('Failed to resolve Checkov version, falling back to latest tag', { error });
        return { version: 'latest', resolvedVersion: 'latest' };
    }
};

type CheckovInstallationMethod = 'pip3' | 'pipenv' | 'docker';
export interface CheckovInstallation {
    checkovInstallationMethod: CheckovInstallationMethod;
    checkovPath: string;
    version?: string;  // The version to use in Docker commands
    actualVersion?: string;  // The actual Checkov version for display
}

const installOrUpdateCheckovWithDocker = async (logger: Logger, checkovVersion: string): Promise<CheckovInstallation | null> => {
    logger.info('Trying to install Checkov using Docker.');
    try {
        const { version, resolvedVersion } = await resolveCheckovVersion(logger, checkovVersion);
        const command = `docker pull bridgecrew/checkov:${resolvedVersion}`;
        logger.debug(`Testing docker installation with command: ${command}`);

        try {
            await asyncExec(command);
            const checkovPath = 'docker';
            logger.info('Checkov installed successfully using Docker.', { checkovPath, version: resolvedVersion });
            const installation: CheckovInstallation = {
                checkovInstallationMethod: 'docker',
                checkovPath,
                version: resolvedVersion,  // This is what will be used for Docker commands
                actualVersion: version     // This is what will be shown in the UI
            };
            return installation;
        } catch (error) {
            // If specific version fails and it's not already 'latest', try falling back to latest
            if (resolvedVersion !== 'latest') {
                logger.warn(`Failed to pull Checkov version ${resolvedVersion}, falling back to latest`, { error });
                await asyncExec('docker pull bridgecrew/checkov:latest');
                // Clear cache since version resolution failed
                versionCache = null;
                // When falling back to latest, we still want to show the actual version in the UI
                const fallbackInstallation: CheckovInstallation = {
                    checkovInstallationMethod: 'docker',
                    checkovPath: 'docker',
                    version: 'latest',      // Use latest for Docker commands
                    actualVersion: version  // Show the actual version in UI
                };
                return fallbackInstallation;
            }
            throw error;
        }
    } catch (error) {
        logger.error('Failed to install or update Checkov using Docker. Error: ', { error });
        return null;
    }
};

export const installOrUpdateCheckov = async (logger: Logger, installationDir: string, checkovVersion: string): Promise<CheckovInstallation> => {
    const dockerCheckovInstallation = await installOrUpdateCheckovWithDocker(logger, checkovVersion);
    if (dockerCheckovInstallation) return dockerCheckovInstallation;
    const pip3CheckovPath = await installOrUpdateCheckovWithPip3(logger, checkovVersion);
    if (pip3CheckovPath) return { checkovInstallationMethod: 'pip3' , checkovPath: pip3CheckovPath };
    const pipenvCheckovPath = await installOrUpdateCheckovWithPipenv(logger, installationDir, checkovVersion);
    if (pipenvCheckovPath) return { checkovInstallationMethod: 'pipenv' , checkovPath: pipenvCheckovPath };

    logger.warn('All installation / update methods failed; attempting to fall back to a global checkov installation');

    if (await isPipCheckovInstalledGlobally()) {
        logger.warn('Checkov appears to be installed globally, so it will be used. However, it may be an outdated version.');
        // it could be installed manually via pip, brew, or something else. this return value will make it just use the `checkov` command.
        return { checkovInstallationMethod: 'pip3' , checkovPath: 'checkov' };
    } else {
        logger.error('Could not find a global `checkov` executable either');
    }

    throw new Error('Could not install Checkov.');
};

export const clearVersionCache = (): void => {
    versionCache = null;
};
