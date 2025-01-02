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
    } catch (err) {
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
}

let versionCache: VersionCache | null = null;
const VERSION_CACHE_TTL = 1000 * 60 * 60; // 1 hour

const resolveCheckovVersion = async (logger: Logger, requestedVersion: string): Promise<string> => {
    // If a specific version is requested, use it
    if (requestedVersion !== 'latest') {
        return requestedVersion;
    }

    // Check cache first
    const now = Date.now();
    if (versionCache && (now - versionCache.timestamp) < VERSION_CACHE_TTL) {
        logger.debug('Using cached Checkov version', { version: versionCache.version });
        return versionCache.version;
    }

    try {
        // Try to get the latest version
        const [versionOutput] = await asyncExec('docker run --rm --interactive bridgecrew/checkov:latest -v');
        const version = versionOutput.trim();
        
        // Cache the result
        versionCache = { version, timestamp: now };
        return version;
    } catch (error) {
        logger.warn('Failed to resolve latest Checkov version, falling back to latest tag', { error });
        return 'latest';
    }
};

const installOrUpdateCheckovWithDocker = async (logger: Logger, checkovVersion: string): Promise<string | null> => {
    logger.info('Trying to install Checkov using Docker.');
    try {
        // First try the specific version
        const resolvedVersion = await resolveCheckovVersion(logger, checkovVersion);
        const command = `docker pull bridgecrew/checkov:${resolvedVersion}`;
        logger.debug(`Testing docker installation with command: ${command}`);
        
        try {
            await asyncExec(command);
        } catch (error) {
            // If specific version fails, fall back to latest
            if (resolvedVersion !== 'latest') {
                logger.warn(`Failed to pull Checkov version ${resolvedVersion}, falling back to latest`, { error });
                await asyncExec('docker pull bridgecrew/checkov:latest');
                // Clear cache since version resolution failed
                versionCache = null;
            } else {
                throw error;
            }
        }
        
        const checkovPath = 'docker';
        logger.info('Checkov installed successfully using Docker.', { checkovPath });
        return checkovPath;
    } catch (error) {
        logger.error('Failed to install or update Checkov using Docker. Error: ', { error });
        return null;
    }
};

type CheckovInstallationMethod = 'pip3' | 'pipenv' | 'docker';
export interface CheckovInstallation {
    checkovInstallationMethod: CheckovInstallationMethod;
    checkovPath: string;
    version?: string;
}

export const installOrUpdateCheckov = async (logger: Logger, installationDir: string, checkovVersion: string): Promise<CheckovInstallation> => {
    const dockerCheckovPath = await installOrUpdateCheckovWithDocker(logger, checkovVersion);
    if (dockerCheckovPath) return { checkovInstallationMethod: 'docker' , checkovPath: dockerCheckovPath };
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
