import * as nodePath from 'path';
import { existsSync, readFileSync } from 'fs';
import { Logger } from 'winston';
import { PathLib } from './checkov/scanCommand';

const configFileNames = ['.checkov.yml', '.checkov.yaml'];

// Returns the config files that apply to a scanned file, nearest first.
// The nearest one, found in the file's directory or any parent up to the workspace folder, is passed to Checkov.
// Checkov also loads the config in its working directory (the workspace folder) and merges the two, so that one is included.
// Files outside a workspace folder get no config, so a config next to an arbitrary file is never picked up.
export const findConfigFiles = (filePath: string, workspaceFolder: string | undefined, exists: (path: string) => boolean = existsSync, pathLib: PathLib = nodePath): string[] => {
    if (!workspaceFolder) {
        return [];
    }

    const relative = pathLib.relative(workspaceFolder, filePath);
    if (relative.length === 0 || relative.split(pathLib.sep)[0] === '..' || pathLib.isAbsolute(relative)) {
        return [];
    }

    const findIn = (directory: string): string | undefined =>
        configFileNames.map(fileName => pathLib.join(directory, fileName)).find(exists);

    const directories = relative.split(pathLib.sep).slice(0, -1);
    for (let depth = directories.length; depth > 0; depth--) {
        const nearest = findIn(pathLib.join(workspaceFolder, ...directories.slice(0, depth)));
        if (nearest) {
            const rootConfig = findIn(workspaceFolder);
            return rootConfig ? [nearest, rootConfig] : [nearest];
        }
    }

    const rootConfig = findIn(workspaceFolder);
    return rootConfig ? [rootConfig] : [];
};

export const configHasSkipCheck = (configPaths: string[], logger: Logger): boolean =>
    configPaths.some(configPath => {
        try {
            const configContent = readFileSync(configPath, 'utf8');
            // Check for both skip-check and skip_check formats (YAML supports both)
            return /^\s*skip[-_]check\s*:/m.test(configContent);
        } catch (error) {
            logger.warn(`Failed to read config file ${configPath}:`, error);
            return false;
        }
    });
