import { randomUUID } from 'crypto';
import * as path from 'path';
import * as semver from 'semver';
import { Logger } from 'winston';
import { Clock, systemClock } from '../clock';
import { parseCheckovResponse } from './checkovParser';
import { FailedCheckovCheck } from './models';
import { ProcessHost, RunningProcess } from './processHost';
import { buildScanCommand, checkovEnvironment, checkovImage, CheckovInstallationMethod, DockerSelinuxMode, parseShebangInterpreter, ScanCommandOptions } from './scanCommand';

export interface CheckovScanRequest {
    filePath: string;
    workspaceRoot?: string;
    configPaths: string[];
    certPath?: string;
    externalChecksDir?: string;
    useBcIds?: boolean;
    noCertVerify?: boolean;
    debugLogs?: boolean;
    frameworks?: string[];
    skipFrameworks?: string[];
    skipChecks?: string[];
    selinuxMode?: DockerSelinuxMode;
}

export interface CheckovInstallation {
    readonly method: CheckovInstallationMethod;
    readonly displayVersion?: string;
    scan(request: CheckovScanRequest, signal: AbortSignal): Promise<FailedCheckovCheck[]>;
}

export interface CheckovInstaller {
    install(requestedVersion: string): Promise<CheckovInstallation>;
    clearVersionCache(): void;
}

export interface CheckovInstallerDependencies {
    host: ProcessHost;
    logger: Logger;
    installationDir: string;
    extensionVersion: string;
    clock?: Clock;
}

interface DockerImage {
    tag: string;
    version: string;
}

interface LocalCommand {
    path: string;
    args: string[];
}

// What differs between running Checkov in Docker and running a local install.
interface ScanAdapter {
    method: CheckovInstallationMethod;
    commandOptions: Pick<ScanCommandOptions, 'checkovPath' | 'checkovArgs' | 'dockerImageTag'>;
    workingDirectory(request: CheckovScanRequest): string;
    stop(checkov: RunningProcess, containerName: string): void;
}

const versionCacheTtlMs = 60 * 60 * 1000;
const minPythonVersion = '3.7.0';
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const maximumJsonStarts = 10;

// Checkov can print log lines before its JSON and notices after it, and the Docker image wraps output in colour codes.
// Each line that could start the JSON is tried in turn, up to the last line that could end it.
// Checkov's JSON starts at the beginning of a line, so indented lines inside it are never tried, and the attempts are capped.
const parseScanOutput = (stdout: string, useBcIds: boolean | undefined, logger: Logger): FailedCheckovCheck[] => {
    const lines = stdout.replace(ansiEscape, '').split(/\r?\n/);
    const starts = lines.flatMap((line, index) => /^[[{]/.test(line) ? [index] : []).slice(0, maximumJsonStarts);
    if (starts.length === 0) {
        throw new Error(`Checkov returned no results: ${stdout.trim().slice(0, 200)}`);
    }
    const end = lines.reduce((last, line, index) => /[\]}]\s*$/.test(line) ? index : last, -1);
    for (const start of starts.filter(index => index <= end)) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(lines.slice(start, end + 1).join('\n'));
        } catch {
            continue;
        }
        if (start > 0) {
            logger.debug(`Log from Checkov: ${lines.slice(0, start).join('\n')}`);
        }
        return parseCheckovResponse(parsed as Parameters<typeof parseCheckovResponse>[0], useBcIds).results.failedChecks;
    }
    throw new Error(`Checkov returned output that is not valid JSON: ${lines.slice(starts[0]).join('\n').trim().slice(0, 200)}`);
};

const parseRepoName = (repoUrl: string): string | null => {
    const url = repoUrl.endsWith('/') ? repoUrl.slice(0, -1) : repoUrl;
    const lastSlash = url.lastIndexOf('/');
    if (lastSlash === -1) {
        return null;
    }
    // / is used in https URLs, and : in git@ URLs
    const priorSeparator = Math.max(url.lastIndexOf('/', lastSlash - 1), url.lastIndexOf(':', lastSlash - 1));
    if (priorSeparator === -1) {
        return null;
    }
    const repoName = url.substring(priorSeparator + 1, url.endsWith('.git') ? url.length - 4 : url.length);
    // Remotes such as codecommit::us-west-2://repo_name have no organisation to use.
    return repoName.split('/').some(part => part === '') ? null : repoName;
};

export const createCheckovInstaller = ({ host, logger, installationDir, extensionVersion, clock = systemClock }: CheckovInstallerDependencies): CheckovInstaller => {
    const isWindows = host.platform === 'win32';
    const pathLib = isWindows ? path.win32 : path.posix;
    let latestImage: { image: DockerImage, resolvedAt: number } | undefined;

    const pullImage = (tag: string) => host.execFile('docker', ['pull', `${checkovImage}:${tag}`]);

    // The latest image is pinned to its own version tag when there is one, so later scans keep using the version that was shown.
    const resolveLatestImage = async (): Promise<DockerImage> => {
        if (latestImage && clock.now() - latestImage.resolvedAt < versionCacheTtlMs) {
            await pullImage(latestImage.image.tag);
            return latestImage.image;
        }
        await pullImage('latest');
        let version: string;
        try {
            const [output] = await host.execFile('docker', ['run', '--rm', '--interactive', `${checkovImage}:latest`, '-v']);
            version = output.trim();
        } catch (error) {
            logger.warn('Could not read the version of the latest Checkov image', { error });
            return { tag: 'latest', version: 'latest' };
        }
        const tag = await pullImage(version).then(() => version, error => {
            logger.info(`Checkov ${version} has no image tag of its own, using latest`, { error });
            return 'latest';
        });
        latestImage = { image: { tag, version }, resolvedAt: clock.now() };
        return latestImage.image;
    };

    const installWithDocker = async (requestedVersion: string): Promise<DockerImage | undefined> => {
        try {
            if (requestedVersion !== 'latest') {
                try {
                    await pullImage(requestedVersion);
                    return { tag: requestedVersion, version: requestedVersion };
                } catch (error) {
                    logger.warn(`Could not pull ${checkovImage}:${requestedVersion}, falling back to the latest image`, { error });
                }
            }
            return await resolveLatestImage();
        } catch (error) {
            logger.error('Failed to install or update Checkov using Docker', { error });
            return undefined;
        }
    };

    const verifyPython = async (pythonExe: string, args = ['--version']): Promise<void> => {
        try {
            const [output] = await host.execFile(pythonExe, args);
            const version = semver.coerce(output)?.version;
            if (!version || semver.lt(version, minPythonVersion)) {
                throw new Error(`${pythonExe} is Python ${version ?? output.trim()}, which is older than ${minPythonVersion}`);
            }
        } catch (error) {
            if (isWindows && pythonExe === 'python3') {
                logger.debug('python3 is not available on Windows, trying python');
                return verifyPython('python');
            }
            throw error;
        }
    };

    // The checkov.cmd launcher runs the script with the first python.cmd, python.bat or python.exe on the PATH.
    // Those can be shims, so ask each one for the real interpreter instead of running it directly.
    const resolveWindowsPython = async (): Promise<string | undefined> => {
        for (const python of ['python.cmd', 'python.bat', 'python.exe']) {
            try {
                const [executable] = await host.execFile(python, ['-'], { input: 'import sys\nprint(sys.executable)\n' });
                if (executable.trim()) return executable.trim();
            } catch (error) {
                logger.debug(`Could not resolve an interpreter from ${python}`, { error });
            }
        }
        return undefined;
    };

    const shebangInterpreter = (scriptPath: string): string | undefined => {
        try {
            return parseShebangInterpreter(host.readFile(scriptPath));
        } catch (error) {
            logger.debug(`Could not read ${scriptPath}`, { error });
            return undefined;
        }
    };

    // On Windows the checkov launcher is a .cmd file, which can only run through cmd.exe.
    // Running the Python script next to it with a real interpreter avoids the shell.
    const windowsScriptCommand = async (scriptPath: string, preferredInterpreter?: string): Promise<LocalCommand> => {
        const candidates = [preferredInterpreter, await resolveWindowsPython(), shebangInterpreter(scriptPath)];
        const interpreters = candidates.filter((candidate, index): candidate is string => !!candidate && candidates.indexOf(candidate) === index);
        for (const interpreter of interpreters) {
            try {
                await host.execFile(interpreter, [scriptPath, '--version']);
                return { path: interpreter, args: [scriptPath] };
            } catch (error) {
                logger.debug(`${interpreter} could not run ${scriptPath}`, { error });
            }
        }
        throw new Error(`Could not find a Python interpreter that runs ${scriptPath}`);
    };

    const findGlobalCheckov = async (): Promise<LocalCommand | undefined> => {
        try {
            if (!isWindows) {
                await host.execFile('checkov', ['--version']);
                return { path: 'checkov', args: [] };
            }
            const [whereOutput] = await host.execFile('where.exe', ['checkov']);
            const launcher = whereOutput.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
            if (!launcher) {
                return undefined;
            }
            if (/\.exe$/i.test(launcher)) {
                await host.execFile(launcher, ['--version']);
                return { path: launcher, args: [] };
            }
            return await windowsScriptCommand(launcher.replace(/\.(cmd|bat)$/i, ''));
        } catch (error) {
            logger.debug('Did not find a global checkov executable', { error });
            return undefined;
        }
    };

    const userScriptsCommand = async (pythonExe: string, pipExe: string): Promise<LocalCommand> => {
        if (!isWindows) {
            const [userBase] = await host.execFile(pythonExe, ['-c', 'import site; print(site.USER_BASE)']);
            return { path: pathLib.join(userBase.trim(), 'bin', 'checkov'), args: [] };
        }
        const [showOutput] = await host.execFile(pipExe, ['show', 'checkov']);
        const location = showOutput.split(/\r?\n/).find(line => line.startsWith('Location: '))?.substring('Location: '.length).trim();
        if (!location) {
            throw new Error('Could not find where pip installed checkov');
        }
        return windowsScriptCommand(pathLib.join(pathLib.dirname(location), 'Scripts', 'checkov'));
    };

    const installWithPip = async (requirement: string): Promise<LocalCommand | undefined> => {
        for (const [pythonExe, pipExe] of [['python3', 'pip3'], ['python', 'pip']]) {
            try {
                await verifyPython(pythonExe);
                await host.execFile(pipExe, ['install', '--user', '-U', '-i', 'https://pypi.org/simple/', requirement]);
                const command = await findGlobalCheckov() ?? await userScriptsCommand(pythonExe, pipExe);
                logger.info(`Checkov installed using ${pipExe}`, { command });
                return command;
            } catch (error) {
                logger.error(`Failed to install or update Checkov using ${pipExe}`, { error });
            }
        }
        return undefined;
    };

    const installWithPipenv = async (requirement: string): Promise<LocalCommand | undefined> => {
        try {
            host.mkdir(installationDir);
            await verifyPython('pipenv', ['run', 'python', '--version']);
            await host.execFile('pipenv', ['--python', '3', 'install', requirement], { cwd: installationDir });
            const [whichOutput] = await host.execFile('pipenv', ['run', isWindows ? 'where' : 'which', 'python'], { cwd: installationDir });
            const pythonPath = whichOutput.split(/\r?\n/)[0].trim();
            const scriptPath = pathLib.join(pathLib.dirname(pythonPath), 'checkov');
            const command = isWindows ? await windowsScriptCommand(scriptPath, pythonPath) : { path: scriptPath, args: [] };
            logger.info('Checkov installed using pipenv', { command, installationDir });
            return command;
        } catch (error) {
            logger.error('Failed to install or update Checkov using pipenv', { error });
            return undefined;
        }
    };

    const readVersion = async (command: LocalCommand): Promise<string | undefined> => {
        try {
            const [output] = await host.execFile(command.path, [...command.args, '-v']);
            return output.trim() || undefined;
        } catch (error) {
            logger.warn('Could not read the installed Checkov version', { error });
            return undefined;
        }
    };

    const gitRepoName = async (filePath: string): Promise<string | null> => {
        try {
            const [output] = await host.execFile('git', ['-C', pathLib.dirname(filePath), 'remote', '-v']);
            const remotes = output.split(/\r?\n/).filter(line => line.includes('\t'));
            const remote = remotes.find(line => line.startsWith('origin\t')) ?? remotes[0];
            return remote ? parseRepoName(remote.split('\t')[1].split(' ')[0]) : null;
        } catch (error) {
            logger.debug('Could not read the git remote of the scanned file', { error });
            return null;
        }
    };

    const dockerAdapter = (image: DockerImage): ScanAdapter => ({
        method: 'docker',
        commandOptions: { checkovPath: 'docker', dockerImageTag: image.tag },
        // Docker needs no working directory, and nothing should be looked up next to a file outside the workspace.
        workingDirectory: () => host.tmpdir(),
        // Killing the client covers a container that does not exist yet, and docker kill one that outlives its client.
        stop: (checkov, containerName) => {
            checkov.kill();
            host.execFile('docker', ['kill', containerName]).catch(error => {
                logger[/no such container/i.test(String(error)) ? 'debug' : 'warn'](`Could not kill container ${containerName}`, { error });
            });
        }
    });

    const localAdapter = (method: CheckovInstallationMethod, command: LocalCommand): ScanAdapter => ({
        method,
        commandOptions: { checkovPath: command.path, checkovArgs: command.args },
        // A local Checkov resolves its config and relative paths from the workspace folder.
        workingDirectory: request => request.workspaceRoot ?? host.tmpdir(),
        stop: checkov => checkov.kill(isWindows ? undefined : 'SIGABRT')
    });

    const scanWith = (adapter: ScanAdapter) => async (request: CheckovScanRequest, signal: AbortSignal): Promise<FailedCheckovCheck[]> => {
        const containerName = `vscode-checkov-${randomUUID()}`;
        const repoId = await gitRepoName(request.filePath);
        if (signal.aborted) {
            throw new Error('Checkov scan cancelled');
        }
        const { command, args } = buildScanCommand({
            ...request,
            ...adapter.commandOptions,
            installationMethod: adapter.method,
            containerName,
            extensionVersion,
            repoId,
            configFilePath: request.configPaths[0]
        }, pathLib);
        logger.info(`Running checkov: ${command} ${args.join(' ')}`);
        const checkov = host.spawn(command, args, {
            cwd: adapter.workingDirectory(request),
            env: { ...host.env, ...checkovEnvironment(extensionVersion, request.debugLogs) }
        });

        const stop = (): void => {
            logger.info('Cancelling the Checkov scan');
            adapter.stop(checkov, containerName);
        };
        signal.addEventListener('abort', stop, { once: true });
        try {
            const { code, stdout, stderr } = await checkov.exited;
            if (stderr.trim()) {
                logger.warn(`Checkov stderr: ${stderr.trim()}`);
            }
            if (signal.aborted) {
                throw new Error('Checkov scan cancelled');
            }
            if (code !== 0) {
                throw new Error(`Checkov exited with code ${code}`);
            }
            return parseScanOutput(stdout, request.useBcIds, logger);
        } finally {
            signal.removeEventListener('abort', stop);
        }
    };

    const dockerInstallation = (image: DockerImage): CheckovInstallation => ({
        method: 'docker',
        displayVersion: image.version,
        scan: scanWith(dockerAdapter(image))
    });

    const localInstallation = async (method: CheckovInstallationMethod, command: LocalCommand): Promise<CheckovInstallation> => ({
        method,
        displayVersion: await readVersion(command),
        scan: scanWith(localAdapter(method, command))
    });

    const install = async (requestedVersion: string): Promise<CheckovInstallation> => {
        const image = await installWithDocker(requestedVersion);
        if (image) {
            logger.info(`Checkov installed using Docker (${checkovImage}:${image.tag})`);
            return dockerInstallation(image);
        }

        const requirement = requestedVersion === 'latest' ? 'checkov' : `checkov==${requestedVersion}`;
        const pipCommand = await installWithPip(requirement);
        if (pipCommand) return localInstallation('pip3', pipCommand);
        const pipenvCommand = await installWithPipenv(requirement);
        if (pipenvCommand) return localInstallation('pipenv', pipenvCommand);

        logger.warn('All installation methods failed; looking for a global checkov');
        const globalCommand = await findGlobalCheckov();
        if (globalCommand) {
            logger.warn('Using the global checkov, which may be an outdated version');
            return localInstallation('global', globalCommand);
        }
        throw new Error('Could not install Checkov.');
    };

    return {
        install,
        clearVersionCache: () => {
            latestImage = undefined;
        }
    };
};
