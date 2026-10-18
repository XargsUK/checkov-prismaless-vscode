import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export interface ExecOptions {
    cwd?: string;
    input?: string;
}

export interface SpawnOptions {
    cwd: string;
    env: NodeJS.ProcessEnv;
}

export interface ProcessResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface RunningProcess {
    readonly exited: Promise<ProcessResult>;
    kill(signal?: NodeJS.Signals): void;
}

export interface ProcessHost {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    execFile(file: string, args: string[], options?: ExecOptions): Promise<[stdout: string, stderr: string]>;
    spawn(command: string, args: string[], options: SpawnOptions): RunningProcess;
    readFile(filePath: string): string;
    mkdir(directory: string): void;
    tmpdir(): string;
}

const shellSafeToken = /^[\w.:/=~-]+$/;

// Runs a command without a shell so arguments are never interpreted.
// On Windows, tools such as pip are often .cmd or .bat shims that only run through cmd.exe,
// so a command made up entirely of plain tokens is still passed to it.
// Windows looks for a bare command name in the working directory before the PATH,
// so commands run from the temp directory unless a caller needs somewhere else.
const runFile = (file: string, args: string[], options: ExecOptions = {}): Promise<[string, string]> => {
    const { input, ...rest } = options;
    const execOptions: childProcess.ExecOptions = { maxBuffer: 1024 * 1000, cwd: os.tmpdir(), ...rest };
    return new Promise((resolve, reject) => {
        const callback = (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
            if (err) { return reject(err); }
            resolve([stdout.toString(), stderr.toString()]);
        };
        const child = process.platform === 'win32' && [file, ...args].every(token => shellSafeToken.test(token))
            ? childProcess.exec([file, ...args].join(' '), execOptions, callback)
            : childProcess.execFile(file, args, execOptions, callback);
        if (input !== undefined) {
            child.stdin?.end(input);
        }
    });
};

const spawnProcess = (command: string, args: string[], options: SpawnOptions): RunningProcess => {
    const child = childProcess.spawn(command, args, options);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    return {
        exited: new Promise((resolve, reject) => {
            child.on('error', reject);
            child.on('close', code => resolve({ code, stdout, stderr }));
        }),
        kill: signal => child.kill(signal)
    };
};

export const nodeProcessHost: ProcessHost = {
    platform: process.platform,
    env: process.env,
    execFile: runFile,
    spawn: spawnProcess,
    readFile: filePath => fs.readFileSync(filePath, 'utf8'),
    mkdir: directory => fs.mkdirSync(directory, { recursive: true }),
    tmpdir: () => os.tmpdir()
};
