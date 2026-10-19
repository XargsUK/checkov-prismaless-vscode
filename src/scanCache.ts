import type { Memento } from 'vscode';
import { Logger } from 'winston';
import { FailedCheckovCheck, FileCache, ResultsCache } from './checkov/models';

const cacheDateKey = 'CKV_CACHE_DATE';
const cacheResultsKey = 'CKV_CACHE_RESULTS';
const maxCacheSizePerFile = 10;

export type FileScanCacheEntry = {
    fileHash: string,
    filename: string,
    results: FailedCheckovCheck[]
};

const startOfDay = (now: number): number => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
};

// The cache only lives for the day it was started on.
const currentCache = (state: Memento, now: number): ResultsCache =>
    state.get(cacheDateKey) === startOfDay(now) ? state.get<ResultsCache>(cacheResultsKey, {}) : {};

export const getCachedResults = (state: Memento, fileHash: string, filename: string, now: number, logger: Logger): FailedCheckovCheck[] | undefined => {
    const entry = currentCache(state, now)[filename]?.elements.find(element => element.fileHash === fileHash);
    logger.debug(`${entry ? 'Found' : 'No'} cached results for ${filename} (hash: ${fileHash})`);
    return entry?.results;
};

export const saveCachedResults = (state: Memento, fileHash: string, filename: string, results: FailedCheckovCheck[], now: number, logger: Logger): void => {
    const cache = currentCache(state, now);
    const fileCache: FileCache = cache[filename] ?? { oldest: 0, elements: [] };
    if (fileCache.elements.some(element => element.fileHash === fileHash)) {
        logger.debug(`Cache for ${filename} already has an entry for hash ${fileHash}`);
        return;
    }

    const elements = [...fileCache.elements];
    let oldest = fileCache.oldest;
    const entry: FileScanCacheEntry = { fileHash, filename, results };
    if (elements.length < maxCacheSizePerFile) {
        elements.push(entry);
    } else {
        elements[oldest] = entry;
        oldest = (oldest + 1) % elements.length;
    }

    logger.debug(`Saving results for ${filename} (hash: ${fileHash}); it now has ${elements.length} saved results`);
    state.update(cacheResultsKey, { ...cache, [filename]: { oldest, elements } });
    state.update(cacheDateKey, startOfDay(now));
};

export const clearCache = (state: Memento, logger: Logger): void => {
    logger.debug('Clearing results cache');
    state.update(cacheResultsKey, undefined);
    state.update(cacheDateKey, undefined);
};
