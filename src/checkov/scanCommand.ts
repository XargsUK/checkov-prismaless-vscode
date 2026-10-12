import * as fs from 'fs';
import * as nodePath from 'path';

export type CheckovInstallationMethod = 'pip3' | 'pipenv' | 'docker';
export type DockerSelinuxMode = 'off' | 'relabel' | 'disable';
export type PathLib = Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'resolve' | 'basename' | 'join' | 'sep'>;

const dockerMountDir = '/checkovScan';
const configMountDir = '/checkovConfig';
const caMountDir = '/checkovCert';
const externalChecksMountDir = '/checkovExternalChecks';
const defaultRepoId = 'vscode/default';

export interface ScanCommandOptions {
    installationMethod: CheckovInstallationMethod;
    checkovPath: string;
    checkovArgs?: string[];
    dockerImageTag: string;
    containerName: string;
    extensionVersion: string;
    workspaceRoot?: string;
    filePath: string;
    repoId?: string | null;
    configFilePath?: string;
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

export interface ScanCommand {
    command: string;
    args: string[];
}

// Values are passed to Checkov as separate arguments, so one starting with a dash would be read as an option.
export const sanitiseOptionValues = (values: string[] | undefined): string[] =>
    (values ?? []).map(value => value.trim()).filter(value => value.length > 0 && !value.startsWith('-'));

// pip rewrites the first line of an installed script to point at the interpreter it was installed for.
export const parseShebangInterpreter = (scriptContent: string): string | undefined => {
    const match = /^#!\s*(?:"([^"\r\n]+)"|([^\r\n]+))/.exec(scriptContent);
    const interpreter = (match?.[1] ?? match?.[2])?.trim();
    return interpreter && /^([a-zA-Z]:\\|\\\\)/.test(interpreter) ? interpreter : undefined;
};

export const getDockerPathParams = (workspaceRoot: string | undefined, filePath: string, pathLib: PathLib = nodePath): [string | null, string] => {
    if (!workspaceRoot) {
        return [null, filePath];
    }
    const relative = pathLib.relative(workspaceRoot, filePath);
    return relative.length > 0 && !relative.startsWith('../') && !relative.startsWith('..\\') && !pathLib.isAbsolute(relative) ? [workspaceRoot, relative] : [null, filePath];
};

const toContainerPath = (relativePath: string, pathLib: PathLib): string => {
    const posixPath = relativePath.split(pathLib.sep).join('/');
    return posixPath.startsWith('-') ? `./${posixPath}` : posixPath;
};

const getDockerArgs = (options: ScanCommandOptions, pathLib: PathLib): string[] => {
    const bindMount = (hostPath: string, containerPath: string, volumeOptions = 'ro'): string[] => ['-v', `${hostPath}:${containerPath}:${volumeOptions}`];

    const mounts: string[] = [];
    const checkovArgs: string[] = [];
    const mountAuxiliaryPath = (mountDir: string, hostPath: string | undefined, flag: string): void => {
        if (!hostPath) {
            return;
        }
        const absPath = pathLib.resolve(hostPath);
        const containerPath = `${mountDir}/${pathLib.basename(absPath)}`;
        mounts.push(...bindMount(absPath, containerPath));
        checkovArgs.push(flag, containerPath);
    };

    // A file inside the workspace is scanned relative to the mounted workspace.
    // Any other file is mounted on its own so its parent directory is not exposed to the container.
    const [mountRoot, pathToScan] = getDockerPathParams(options.workspaceRoot, options.filePath, pathLib);
    let fileToScan: string;
    if (mountRoot) {
        // Relabelling is permanent on the host, so it is limited to the workspace folder.
        // Files mounted from anywhere else (system files, certificates) keep their labels.
        mounts.push(...bindMount(mountRoot, dockerMountDir, options.selinuxMode === 'relabel' ? 'ro,z' : 'ro'));
        fileToScan = toContainerPath(pathToScan, pathLib);
    } else {
        const absPath = pathLib.resolve(pathToScan);
        fileToScan = toContainerPath(pathLib.basename(absPath), pathLib);
        mounts.push(...bindMount(absPath, `${dockerMountDir}/${pathLib.basename(absPath)}`));
    }

    mountAuxiliaryPath(configMountDir, options.configFilePath, '--config-file');
    mountAuxiliaryPath(caMountDir, options.certPath, '--ca-certificate');
    mountAuxiliaryPath(externalChecksMountDir, options.externalChecksDir, '--external-checks-dir');

    return [
        'run', '--rm', '--interactive', '--name', options.containerName,
        ...(options.debugLogs ? ['--env', 'LOG_LEVEL=DEBUG'] : []),
        '--env', 'BC_SOURCE=vscode', '--env', `BC_SOURCE_VERSION=${options.extensionVersion}`,
        ...(options.selinuxMode === 'disable' ? ['--security-opt', 'label=disable'] : []),
        ...mounts, '-w', dockerMountDir,
        `bridgecrew/checkov:${options.dockerImageTag}`,
        ...checkovArgs, '-f', fileToScan
    ];
};

const getLocalArgs = (options: ScanCommandOptions): string[] => [
    ...(options.checkovArgs ?? []),
    '-f', options.filePath,
    ...(options.certPath ? ['-ca', options.certPath] : []),
    ...(options.configFilePath ? ['--config-file', options.configFilePath] : []),
    ...(options.externalChecksDir ? ['--external-checks-dir', options.externalChecksDir] : [])
];

export const buildScanCommand = (options: ScanCommandOptions, pathLib: PathLib = nodePath): ScanCommand => {
    const isDocker = options.installationMethod === 'docker';
    const repoId = options.repoId && !options.repoId.startsWith('-') ? options.repoId : defaultRepoId;
    const frameworks = sanitiseOptionValues(options.frameworks);
    const skipFrameworks = sanitiseOptionValues(options.skipFrameworks);
    const skipChecks = sanitiseOptionValues(options.skipChecks);

    return {
        command: isDocker ? 'docker' : options.checkovPath,
        args: [
            ...(isDocker ? getDockerArgs(options, pathLib) : getLocalArgs(options)),
            ...(options.useBcIds ? ['--output-bc-ids'] : []),
            ...(options.noCertVerify ? ['--no-cert-verify'] : []),
            '-s', '--repo-id', repoId, '-o', 'json',
            ...(frameworks.length > 0 ? ['--framework', ...frameworks] : []),
            ...(skipFrameworks.length > 0 ? ['--skip-framework', ...skipFrameworks] : []),
            ...(skipChecks.length > 0 ? ['--skip-check', skipChecks.join(',')] : [])
        ]
    };
};

const realPathOrUndefined = (target: string): string | undefined => {
    try {
        return fs.realpathSync(target);
    } catch {
        return undefined;
    }
};

// A workspace can only point at an existing directory inside its own folder, after resolving symlinks.
// Any other location has to come from user settings, so opening a repository cannot make
// a directory elsewhere on the machine visible to the scan.
export const resolveExternalChecksDir = (userValue: string | undefined, workspaceValue: string | undefined, workspaceFolder: string | undefined,
    pathLib: PathLib = nodePath, realPath: (target: string) => string | undefined = realPathOrUndefined): string | undefined => {
    if (workspaceValue && workspaceFolder) {
        const resolved = pathLib.resolve(workspaceFolder, workspaceValue);
        const realFolder = realPath(workspaceFolder);
        const realResolved = realPath(resolved);
        if (realFolder && realResolved) {
            const relative = pathLib.relative(realFolder, realResolved);
            if (relative.split(pathLib.sep)[0] !== '..' && !pathLib.isAbsolute(relative)) {
                return resolved;
            }
        }
    }
    if (!userValue) {
        return undefined;
    }
    return workspaceFolder ? pathLib.resolve(workspaceFolder, userValue) : userValue;
};
