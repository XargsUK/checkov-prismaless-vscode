import * as crypto from 'crypto';
import * as fs from 'fs';

export const hashContent = (content: string | Buffer): string => crypto.createHash('md5').update(content).digest('hex');

export const fileHash = (filePath: string): string => hashContent(fs.readFileSync(filePath));

export const fileHashOrUnreadable = (filePath: string): string => {
    try {
        return fileHash(filePath);
    } catch {
        return 'unreadable';
    }
};
