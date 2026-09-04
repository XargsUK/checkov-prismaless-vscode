import * as path from 'path';
import { existsSync, readFileSync } from 'fs';
import { Logger } from 'winston';
import { getWorkspacePath } from './utils';

export const checkovIgnoreFileName = '.checkovignore';

// Convert a gitignore-style glob pattern into a regular expression.
// '*' matches within a path segment, '**' matches across segments, '?' matches a single character.
const globToRegExp = (glob: string): RegExp => {
    let regex = '';
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    regex += '(?:.*/)?'; // '**/' also matches zero directories
                    i += 2;
                } else {
                    regex += '.*';
                    i += 1;
                }
            } else {
                regex += '[^/]*';
            }
        } else if (char === '?') {
            regex += '[^/]';
        } else {
            regex += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${regex}$`);
};

const parseIgnoreFile = (logger: Logger, ignoreFilePath: string): string[] => {
    try {
        return readFileSync(ignoreFilePath, 'utf8')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#'));
    } catch (error) {
        logger.warn(`Failed to read ${ignoreFilePath}:`, { error });
        return [];
    }
};

const matchesPattern = (rawPattern: string, relativePath: string): boolean => {
    let pattern = rawPattern.replace(/\\/g, '/');
    // A leading '/' anchors the pattern to the workspace root
    const anchored = pattern.startsWith('/');
    if (anchored) {
        pattern = pattern.substring(1);
    }
    if (pattern.endsWith('/')) {
        pattern += '**';
    }
    const regex = globToRegExp(pattern);

    if (regex.test(relativePath)) {
        return true;
    }
    // An unanchored pattern without a slash (e.g. '*.md' or 'node_modules') matches any path segment,
    // so files anywhere in the tree - and everything under a matched directory - are ignored.
    if (!anchored && !pattern.includes('/')) {
        return relativePath.split('/').some(segment => regex.test(segment));
    }
    return false;
};

/**
 * Returns true if the given file is matched by a pattern in the workspace's .checkovignore file.
 * Patterns follow gitignore-style globs, one per line; blank lines and lines starting with '#' are skipped.
 */
export const isFileIgnored = (logger: Logger, filePath: string): boolean => {
    const workspacePath = getWorkspacePath(logger);
    const ignoreFileDir = workspacePath || path.dirname(filePath);
    const ignoreFilePath = path.join(ignoreFileDir, checkovIgnoreFileName);

    if (!existsSync(ignoreFilePath)) {
        return false;
    }

    const relativePath = path.relative(ignoreFileDir, filePath).split(path.sep).join('/');
    if (relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
        // File is outside the directory containing the ignore file
        return false;
    }

    const patterns = parseIgnoreFile(logger, ignoreFilePath);
    const matched = patterns.find(pattern => matchesPattern(pattern, relativePath));
    if (matched) {
        logger.debug(`File ${relativePath} matches ${checkovIgnoreFileName} pattern '${matched}'`);
        return true;
    }
    return false;
};
