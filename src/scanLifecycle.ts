import type { Memento } from 'vscode';
import { Logger } from 'winston';
import { FailedCheckovCheck } from './checkov/models';
import { getCachedResults, saveCachedResults } from './scanCache';
import { Clock, systemClock } from './clock';

export type CheckovInvocation<TOptions> = (filePath: string, options: TOptions, signal: AbortSignal) => Promise<FailedCheckovCheck[]>;

export interface ScanRequest<TOptions> {
    uri: string;
    filePath: string;
    cacheKey: string;
    useCache: boolean;
    options: TOptions;
}

export type CancelReason = 'superseded' | 'limit' | 'requested';

export type ScanOutcome =
    | { kind: 'findings', uri: string, findings: FailedCheckovCheck[] }
    | { kind: 'cancelled', uri: string, reason: CancelReason }
    | { kind: 'timedOut', uri: string, timeoutSeconds: number }
    | { kind: 'error', uri: string, error: unknown };

export interface ScanLimits {
    timeoutSeconds: number;
    maximumConcurrentScans: number;
}

export interface ScanLifecycleDependencies<TOptions> {
    invoke: CheckovInvocation<TOptions>;
    cache: Memento;
    limits: () => ScanLimits;
    logger: Logger;
    clock?: Clock;
}

export interface ScanLifecycle<TOptions> {
    scan(request: ScanRequest<TOptions>): Promise<ScanOutcome>;
    cancel(uri: string): void;
    cancelAll(): void;
}

const debounceMs = 100;

interface ActiveScan {
    uri: string;
    controller: AbortController;
    started: boolean;
    timer?: unknown;
    finish(outcome: ScanOutcome): void;
}

export const createScanLifecycle = <TOptions>({ invoke, cache, limits, logger, clock = systemClock }: ScanLifecycleDependencies<TOptions>): ScanLifecycle<TOptions> => {
    const active: ActiveScan[] = [];

    const stop = (scan: ActiveScan, outcome: ScanOutcome): void => {
        scan.controller.abort();
        scan.finish(outcome);
    };

    const cancelScansFor = (uri: string, reason: CancelReason): void => {
        for (const scan of active.filter(item => item.uri === uri)) {
            logger.debug(`Cancelling existing scan for ${uri}`);
            stop(scan, { kind: 'cancelled', uri, reason });
        }
    };

    const cancelAll = (): void => {
        logger.debug(`Cancelling all ${active.length} active scans`);
        for (const scan of [...active]) {
            stop(scan, { kind: 'cancelled', uri: scan.uri, reason: 'requested' });
        }
    };

    const enforceConcurrencyLimit = (): void => {
        const running = active.filter(item => item.started);
        const maximumConcurrentScans = Math.max(1, limits().maximumConcurrentScans);
        for (const oldest of running.slice(0, Math.max(0, running.length - maximumConcurrentScans))) {
            logger.info(`Cancelling scan of ${oldest.uri} due to the concurrent scan limit`);
            stop(oldest, { kind: 'cancelled', uri: oldest.uri, reason: 'limit' });
        }
    };

    const startInvocation = async (scan: ActiveScan, request: ScanRequest<TOptions>): Promise<void> => {
        logger.info(`Starting to scan ${request.filePath}`);
        scan.started = true;
        enforceConcurrencyLimit();
        const { timeoutSeconds } = limits();
        scan.timer = clock.setTimeout(() => {
            logger.warn(`Cancelling scan of ${request.filePath} after the ${timeoutSeconds}s timeout`);
            stop(scan, { kind: 'timedOut', uri: request.uri, timeoutSeconds });
        }, timeoutSeconds * 1000);
        try {
            const findings = await invoke(request.filePath, request.options, scan.controller.signal);
            if (!scan.controller.signal.aborted) {
                saveCachedResults(cache, request.cacheKey, request.filePath, findings, clock.now(), logger);
            }
            scan.finish({ kind: 'findings', uri: request.uri, findings });
        } catch (error) {
            scan.finish({ kind: 'error', uri: request.uri, error });
        }
    };

    const scan = (request: ScanRequest<TOptions>): Promise<ScanOutcome> => {
        cancelScansFor(request.uri, 'superseded');

        const cached = request.useCache ? getCachedResults(cache, request.cacheKey, request.filePath, clock.now(), logger) : undefined;
        if (cached) {
            return Promise.resolve({ kind: 'findings', uri: request.uri, findings: cached });
        }

        return new Promise(resolve => {
            let finished = false;
            const entry: ActiveScan = {
                uri: request.uri,
                controller: new AbortController(),
                started: false,
                finish: outcome => {
                    if (finished) return;
                    finished = true;
                    clock.clearTimeout(entry.timer);
                    const index = active.indexOf(entry);
                    if (index !== -1) active.splice(index, 1);
                    resolve(outcome);
                }
            };
            active.push(entry);
            entry.timer = clock.setTimeout(() => startInvocation(entry, request), debounceMs);
        });
    };

    return { scan, cancel: uri => cancelScansFor(uri, 'requested'), cancelAll };
};
