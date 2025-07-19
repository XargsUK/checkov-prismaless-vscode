import * as path from 'path';
import { existsSync } from 'fs';
import { Logger } from 'winston';
import { getWorkspacePath } from './utils';

export const getConfigFilePath = (logger: Logger, filePath: string): string | undefined => {
    const baseDir = path.dirname(filePath);
    logger.debug(`Base dir of file to be scanned: ${baseDir}`);

    const checkDirs: string[] = [];
    const workspacePath = getWorkspacePath(logger);

    if (workspacePath) {
        const relative = path.relative(workspacePath, filePath);
        const isInWorkspace = !relative.startsWith('..') && !path.isAbsolute(relative);

        logger.debug(`Workspace path: ${workspacePath}`);
        logger.debug(`Is file in workspace: ${isInWorkspace}`);

        if (isInWorkspace) {
            // Search upward from baseDir to workspacePath
            let currentDir = baseDir;
            while (currentDir.startsWith(workspacePath)) {
                checkDirs.push(currentDir);
                const parentDir = path.dirname(currentDir);
                if (parentDir === currentDir) break;
                currentDir = parentDir;
            }
        } else {
            // Only check the base directory
            checkDirs.push(baseDir);
        }
    } else {
        // No workspace, only check the base directory
        checkDirs.push(baseDir);
    }

    for (const dir of checkDirs) {
        const ymlPath = path.join(dir, '.checkov.yml');
        const yamlPath = path.join(dir, '.checkov.yaml');
        if (existsSync(ymlPath)) {
            logger.debug(`Config file found at: ${ymlPath}`);
            return ymlPath;
        }
        if (existsSync(yamlPath)) {
            logger.debug(`Config file found at: ${yamlPath}`);
            return yamlPath;
        }
    }

    logger.debug('No config file found.');
    return undefined;
};
