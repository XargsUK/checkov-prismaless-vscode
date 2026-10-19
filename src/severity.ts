import type { Memento } from 'vscode';
import * as fs from 'fs';
import { Logger } from 'winston';
import { Clock, systemClock } from './clock';

export interface MappingSource {
    fetchReleaseVersion(): Promise<string>;
    fetchMappings(): Promise<unknown>;
}

export type RefreshResult = 'updated' | 'unchanged';
export type MappingsChange = 'loaded' | 'updated';

export interface RefreshOptions {
    // Downloads the mappings even when the cached release version matches.
    force?: boolean;
}

export interface SeverityMappings {
    resolve(checkId: string, reported: string | undefined): string;
    refresh(options?: RefreshOptions): Promise<RefreshResult>;
    dispose(): void;
}

export interface SeverityMappingsDependencies {
    source: MappingSource;
    cache: Memento;
    loadBundledMappings?: () => unknown;
    logger: Logger;
    onMappingsChanged: (change: MappingsChange) => void;
    clock?: Clock;
}

interface CachedMappings {
    mappings: Record<string, string>;
    releaseVersion: string;
    cachedAt: number;
}

const cacheKey = 'checkovSeverityMappings';
const legacyCacheKey = 'checkov_severity_mappings';
const cacheLifetimeMs = 24 * 60 * 60 * 1000;
const updateCheckIntervalMs = 60 * 60 * 1000;

const severityOrder = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
type Severity = typeof severityOrder[number];

export type DisplayLevel = 'error' | 'warning' | 'information';

const displayLevels: Record<Severity, DisplayLevel> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'information',
    INFO: 'information'
};

const asSeverity = (value: unknown): Severity | undefined =>
    severityOrder.find(severity => typeof value === 'string' && severity === value.toUpperCase());

// Severities that are not in the order (UNKNOWN, custom policies) are always shown,
// so a finding is never hidden just because its severity could not be resolved.
export const meetsMinimumSeverity = (severity: string, minimumSeverity: string): boolean => {
    const minimum = asSeverity(minimumSeverity);
    const actual = asSeverity(severity);
    return !minimum || !actual || severityOrder.indexOf(actual) >= severityOrder.indexOf(minimum);
};

export const displayLevel = (severity: string): DisplayLevel => {
    const known = asSeverity(severity);
    return known ? displayLevels[known] : 'warning';
};

const parseMappings = (file: unknown): Record<string, string> => {
    const entries = Object.entries((file as { mappings?: Record<string, unknown> } | undefined)?.mappings ?? {});
    if (entries.length === 0) {
        throw new Error('Severity mappings file has no mappings');
    }
    const invalid = entries.find(([, severity]) => typeof severity !== 'string' || !severityOrder.includes(severity as Severity));
    if (invalid) {
        throw new Error(`Invalid severity ${invalid[1]} for ${invalid[0]}`);
    }
    return Object.fromEntries(entries.map(([checkId, severity]) => [checkId.toUpperCase(), severity as string]));
};

// Mappings without a release version (bundled with the extension, or cached by the previous provider)
// are used until the first refresh replaces them.
const unreleasedMappings = (file: unknown, description: string, logger: Logger): CachedMappings | undefined => {
    if (file === undefined) return undefined;
    try {
        return { mappings: parseMappings(file), releaseVersion: '', cachedAt: 0 };
    } catch (error) {
        logger.warn(`Ignoring the ${description} severity mappings`, { error });
        return undefined;
    }
};

const readLegacyCache = (cache: Memento, logger: Logger): CachedMappings | undefined => {
    const legacy = cache.get<{ data?: unknown }>(legacyCacheKey);
    if (!legacy) return undefined;
    cache.update(legacyCacheKey, undefined).then(undefined, error => logger.warn('Failed to remove the old severity mappings cache', { error }));
    return unreleasedMappings(legacy.data, 'previously cached', logger);
};

const sameMappings = (a: Record<string, string>, b: Record<string, string>): boolean => {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
};

export const createSeverityMappings = ({ source, cache, loadBundledMappings, logger, onMappingsChanged, clock = systemClock }: SeverityMappingsDependencies): SeverityMappings => {
    let current = cache.get<CachedMappings>(cacheKey) ?? readLegacyCache(cache, logger) ?? unreleasedMappings(loadBundledMappings?.(), 'bundled', logger);
    let inFlight: { promise: Promise<RefreshResult>, force: boolean } | undefined;
    let disposed = false;
    let timer: unknown;

    const download = async (force: boolean): Promise<RefreshResult> => {
        const releaseVersion = await source.fetchReleaseVersion();
        if (!force && current?.releaseVersion === releaseVersion) {
            current = { ...current, cachedAt: clock.now() };
            await cache.update(cacheKey, current);
            logger.debug(`Severity mappings are up to date (release ${releaseVersion})`);
            return 'unchanged';
        }
        const mappings = parseMappings(await source.fetchMappings());
        const changed = !current || !sameMappings(current.mappings, mappings);
        current = { mappings, releaseVersion, cachedAt: clock.now() };
        await cache.update(cacheKey, current);
        logger.info(`Loaded ${Object.keys(mappings).length} severity mappings (release ${releaseVersion})${changed ? '' : ', unchanged'}`);
        return changed ? 'updated' : 'unchanged';
    };

    // Overlapping refreshes share one download, except that a forced refresh waits for an unforced one and then downloads.
    const refresh = ({ force = false }: RefreshOptions = {}): Promise<RefreshResult> => {
        if (inFlight && (inFlight.force || !force)) {
            return inFlight.promise;
        }
        const previous = inFlight?.promise.catch(() => undefined) ?? Promise.resolve();
        const promise: Promise<RefreshResult> = previous.then(() => download(force)).finally(() => {
            if (inFlight?.promise === promise) {
                inFlight = undefined;
            }
        });
        inFlight = { promise, force };
        return promise;
    };

    const refreshAndReport = async (): Promise<void> => {
        const hadReleasedMappings = Boolean(current?.releaseVersion);
        try {
            if (await refresh() === 'updated' && !disposed) {
                onMappingsChanged(hadReleasedMappings ? 'updated' : 'loaded');
            }
        } catch (error) {
            logger.warn('Failed to refresh severity mappings', { error });
        }
    };

    const scheduleUpdateCheck = (): void => {
        timer = clock.setTimeout(async () => {
            await refreshAndReport();
            if (!disposed) {
                scheduleUpdateCheck();
            }
        }, updateCheckIntervalMs);
    };

    if (!current || clock.now() - current.cachedAt >= cacheLifetimeMs) {
        refreshAndReport();
    }
    scheduleUpdateCheck();

    return {
        resolve: (checkId, reported) => current?.mappings[checkId.toUpperCase()] || reported || 'UNKNOWN',
        refresh,
        dispose: () => {
            disposed = true;
            clock.clearTimeout(timer);
        }
    };
};

const mappingsRepo = 'xargsuk/checkov-severity-mapper';
const mappingsUrl = `https://github.com/${mappingsRepo}/releases/latest/download/checkov_severity_mappings.json`;
const releaseInfoUrl = `https://github.com/${mappingsRepo}/releases/latest/download/release_info.json`;
const networkTimeoutMs = 10000;
const maxAttempts = 3;

const downloadJson = async (url: string, logger: Logger): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'VSCode-Checkov-Extension/1.0', 'Accept': 'application/json' },
                signal: AbortSignal.timeout(networkTimeoutMs)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            if (attempt === maxAttempts) {
                throw new Error(`Failed to download ${url} after ${maxAttempts} attempts`, { cause: error });
            }
            const delayMs = Math.pow(2, attempt) * 1000;
            logger.debug(`Download of ${url} failed (attempt ${attempt}), retrying in ${delayMs}ms`, { error });
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
};

export const githubMappingSource = (logger: Logger): MappingSource => ({
    fetchReleaseVersion: async () => {
        const releaseInfo = await downloadJson(releaseInfoUrl, logger) as { version?: unknown };
        if (typeof releaseInfo?.version !== 'string') {
            throw new Error('Severity mappings release info has no version');
        }
        return releaseInfo.version;
    },
    fetchMappings: () => downloadJson(mappingsUrl, logger)
});

export const readBundledMappings = (filePath: string, logger: Logger): unknown => {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logger.warn(`Could not read the bundled severity mappings from ${filePath}`, { error });
        return undefined;
    }
};
