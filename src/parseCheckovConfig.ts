import * as path from 'path';
import { existsSync, readFileSync } from 'fs';
import { Logger } from 'winston';
import { getWorkspacePath } from './utils';


export const getConfigFilePath = (logger: Logger): string | undefined => {
    const workspacePath = getWorkspacePath(logger);
    if (workspacePath) {
        const paths =  [path.join(workspacePath, '.checkov.yml'), path.join(workspacePath, '.checkov.yaml')];
        for (const path of paths) {
            if(existsSync(path)) return path;
        }
    }
    return undefined;
};

export const configHasSkipCheck = (logger: Logger): boolean => {
    const configPath = getConfigFilePath(logger);
    if (!configPath) {
        return false;
    }

    try {
        const configContent = readFileSync(configPath, 'utf8');
        // Check for both skip-check and skip_check formats (YAML supports both)
        return /^\s*skip[-_]check\s*:/m.test(configContent);
    } catch (error) {
        logger.warn(`Failed to read config file ${configPath}:`, error);
        return false;
    }
};
