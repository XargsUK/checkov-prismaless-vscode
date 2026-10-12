import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'winston';
import { asyncExecFile, isWindows } from '../utils';
import { verifyPythonVersion } from '../configuration';
import { CheckovInstallationMethod, parseShebangInterpreter } from './scanCommand';

interface CheckovCommand {
    checkovPath: string;
    checkovArgs?: string[];
}

// The checkov.cmd launcher runs the script with the first python.cmd, python.bat or python.exe on the PATH.
// Those can be shims, so ask each one for the real interpreter instead of running it directly.
const resolveWindowsPython = async (logger: Logger): Promise<string | undefined> => {
    for (const python of ['python.cmd', 'python.bat', 'python.exe']) {
        try {
            const [executable] = await asyncExecFile(python, ['-'], { input: 'import sys\nprint(sys.executable)\n' });
            if (executable.trim()) return executable.trim();
        } catch (error) {
            logger.debug(`Could not resolve an interpreter from ${python}`, { error });
        }
    }
    return undefined;
};

// On Windows the checkov launcher is a .cmd file, which can only run through cmd.exe.
// Running the Python script next to it with a real interpreter avoids the shell.
const getWindowsCheckovCommand = async (logger: Logger, scriptPath: string, preferredInterpreter?: string): Promise<CheckovCommand> => {
    const candidates = [preferredInterpreter, await resolveWindowsPython(logger), parseShebangInterpreter(fs.readFileSync(scriptPath, 'utf8'))];
    const interpreters = candidates.filter((candidate, index): candidate is string => !!candidate && candidates.indexOf(candidate) === index);
    for (const interpreter of interpreters) {
        try {
            await asyncExecFile(interpreter, [scriptPath, '--version']);
            return { checkovPath: interpreter, checkovArgs: [scriptPath] };
        } catch (error) {
            logger.debug(`${interpreter} could not run ${scriptPath}`, { error });
        }
    }
    throw new Error(`Could not find a Python interpreter that runs ${scriptPath}`);
};

const findGlobalCheckov = async (logger: Logger): Promise<CheckovCommand | null> => {
    try {
        if (!isWindows) {
            await asyncExecFile('checkov', ['--version']);
            return { checkovPath: 'checkov' };
        }

        const [whereOutput] = await asyncExecFile('where.exe', ['checkov']);
        const launcher = whereOutput.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
        if (!launcher) {
            return null;
        }
        if (/\.exe$/i.test(launcher)) {
            await asyncExecFile(launcher, ['--version']);
            return { checkovPath: launcher };
        }
        return await getWindowsCheckovCommand(logger, launcher.replace(/\.(cmd|bat)$/i, ''));
    } catch (error) {
        // We expect this error if checkov is not installed
        logger.debug('Did not find a global checkov executable', { error });
        return null;
    }
};

const getPipCheckovCommand = async (logger: Logger): Promise<CheckovCommand> => {
    if (!isWindows) {
        const [pythonUserBaseOutput] = await asyncExecFile('python3', ['-c', 'import site; print(site.USER_BASE)']);
        logger.debug(`User base output: ${pythonUserBaseOutput}`);
        return { checkovPath: path.join(pythonUserBaseOutput.trim(), 'bin', 'checkov') };
    } else {
        // Windows has issues with the approach above (no surprise), but we can get to site-packages and from there to the executable
        const [showCheckovOutput] = await asyncExecFile('pip3', ['show', 'checkov']);
        for (const line of showCheckovOutput.split(/\r?\n/)) {
            if (line.startsWith('Location: ')) {
                logger.debug(line);
                const sitePackagePath = line.substring('Location: '.length).trim();
                return getWindowsCheckovCommand(logger, path.join(path.dirname(sitePackagePath), 'Scripts', 'checkov'));
            }
        }
    }

    throw new Error('Failed to find the path to the non-global checkov executable');
};

const installOrUpdateCheckovWithPip3 = async (logger: Logger, checkovVersion: string): Promise<CheckovCommand | null> => {
    logger.info('Trying to install Checkov using pip3.');

    let firstTry = true;
    let pythonExe = 'python3';
    let pipExe = 'pip3';

    while (true) {
        try {
            await verifyPythonVersion(logger, pythonExe);
            const args = ['install', '--user', '-U', '-i', 'https://pypi.org/simple/', `checkov${checkovVersion === 'latest' ? '' : `==${checkovVersion}`}`];
            logger.debug(`Testing pip[3] installation with command: ${pipExe} ${args.join(' ')}`);
            await asyncExecFile(pipExe, args);

            const checkovCommand = await findGlobalCheckov(logger) ?? await getPipCheckovCommand(logger);
            logger.info(`Checkov installed successfully using ${pipExe}.`, { checkovCommand });
            return checkovCommand;
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
    const args = ['run', isWindows ? 'where' : 'which', 'python'];
    logger.debug(`Getting pipenv executable with command: pipenv ${args.join(' ')}`);
    const [execOutput] = await asyncExecFile('pipenv', args, { cwd });

    // Windows returns all results from the path
    return execOutput.split(/\r?\n/)[0].trim();
};

const installOrUpdateCheckovWithPipenv = async (logger: Logger, installationDir: string, checkovVersion: string): Promise<CheckovCommand | null> => {

    logger.info('Trying to install Checkov using pipenv.');

    try {
        fs.mkdirSync(installationDir, { recursive: true });
        logger.debug(`Installation dir: ${installationDir}`);
        const installArgs = ['--python', '3', 'install', `checkov${checkovVersion && checkovVersion.toLowerCase() !== 'latest' ? `==${checkovVersion}` : '~=2.0.0'}`];
        await verifyPythonVersion(logger, 'pipenv', ['run', 'python', '--version']);
        logger.debug(`Testing pipenv installation with command: pipenv ${installArgs.join(' ')}`);
        await asyncExecFile('pipenv', installArgs, { cwd: installationDir });

        const pythonPath = await getPipenvPythonExecutableLocation(logger, installationDir);
        logger.debug(`pipenv python executable: ${pythonPath}`);

        const scriptPath = path.join(path.dirname(pythonPath), 'checkov');
        const checkovCommand = isWindows ? await getWindowsCheckovCommand(logger, scriptPath, pythonPath) : { checkovPath: scriptPath };
        logger.info('Checkov installed successfully using pipenv.', { checkovCommand, installationDir });
        return checkovCommand;
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

const pullCheckovImage = (tag: string) => asyncExecFile('docker', ['pull', `bridgecrew/checkov:${tag}`]);

const checkVersionHasDockerTag = async (version: string, logger: Logger): Promise<boolean> => {
    try {
        await pullCheckovImage(version);
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
        await pullCheckovImage('latest');
        const [versionOutput] = await asyncExecFile('docker', ['run', '--rm', '--interactive', 'bridgecrew/checkov:latest', '-v']);
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

export interface CheckovInstallation extends CheckovCommand {
    checkovInstallationMethod: CheckovInstallationMethod;
    version?: string;  // The version to use in Docker commands
    actualVersion?: string;  // The actual Checkov version for display
}

const installOrUpdateCheckovWithDocker = async (logger: Logger, checkovVersion: string): Promise<CheckovInstallation | null> => {
    logger.info('Trying to install Checkov using Docker.');
    try {
        const { version, resolvedVersion } = await resolveCheckovVersion(logger, checkovVersion);
        logger.debug(`Testing docker installation with command: docker pull bridgecrew/checkov:${resolvedVersion}`);

        try {
            await pullCheckovImage(resolvedVersion);
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
                await pullCheckovImage('latest');
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
    const pip3CheckovCommand = await installOrUpdateCheckovWithPip3(logger, checkovVersion);
    if (pip3CheckovCommand) return { checkovInstallationMethod: 'pip3' , ...pip3CheckovCommand };
    const pipenvCheckovCommand = await installOrUpdateCheckovWithPipenv(logger, installationDir, checkovVersion);
    if (pipenvCheckovCommand) return { checkovInstallationMethod: 'pipenv' , ...pipenvCheckovCommand };

    logger.warn('All installation / update methods failed; attempting to fall back to a global checkov installation');

    const globalCheckovCommand = await findGlobalCheckov(logger);
    if (globalCheckovCommand) {
        logger.warn('Checkov appears to be installed globally, so it will be used. However, it may be an outdated version.');
        // it could be installed manually via pip, brew, or something else. this return value will make it just use the `checkov` command.
        return { checkovInstallationMethod: 'pip3' , ...globalCheckovCommand };
    } else {
        logger.error('Could not find a global `checkov` executable either');
    }

    throw new Error('Could not install Checkov.');
};

export const clearVersionCache = (): void => {
    versionCache = null;
};
