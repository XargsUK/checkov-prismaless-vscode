import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'winston';

// Core interfaces from Integration-Guide.md
export enum SeverityLevel {
    CRITICAL = 'CRITICAL',
    HIGH = 'HIGH',
    MEDIUM = 'MEDIUM',
    LOW = 'LOW',
    INFO = 'INFO',
}

export interface CheckovMappings {
    metadata: {
        version: string;
        timestamp: string;
        total_mappings: number;
        generator_version: string;
        extraction_stats?: {
            total_mappings: number;
            severity_counts: Record<SeverityLevel, number>;
        };
    };
    mappings: Record<string, SeverityLevel>;
}

export interface ReleaseInfo {
    version: string;
    generated_at: string;
    mapping_count: number;
    file_hash: string;
    source_repo: string;
    extractor_version: string;
}

interface CachedMappings {
    data: CheckovMappings;
    cached_at: string;
    version: string;
    expires_at: string;
}

// GitHub API URLs
const REPO = 'xargsuk/checkov-severity-mapper';
const MAPPINGS_URL = `https://github.com/${REPO}/releases/latest/download/checkov_severity_mappings.json`;
const RELEASE_INFO_URL = `https://github.com/${REPO}/releases/latest/download/release_info.json`;

// Cache configuration
const CACHE_KEY = 'checkov_severity_mappings';
const CACHE_DURATION_HOURS = 24;
const UPDATE_CHECK_INTERVAL_HOURS = 1;
const NETWORK_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;

export class CheckovSeverityProvider {
    private mappings: Map<string, SeverityLevel> = new Map();
    private context: vscode.ExtensionContext | null = null;
    private logger: Logger | null = null;
    private lastUpdate: Date | null = null;
    private currentVersion: string | null = null;
    private updateCheckInterval: NodeJS.Timeout | null = null;
    private outputChannel: vscode.OutputChannel;
    private isInitialized: boolean = false;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Checkov Severity Provider');
    }

    /**
     * Initialize the severity provider with VSCode extension context
     */
    async initialize(context: vscode.ExtensionContext, logger?: Logger): Promise<void> {
        this.context = context;
        this.logger = logger || null;
        this.isInitialized = true;

        this.log('Initializing Checkov Severity Provider');

        try {
            await this.loadMappings();
            this.startBackgroundUpdateChecker();
            this.log(`Successfully initialized with ${this.mappings.size} severity mappings`);
        } catch (error) {
            this.logError('Failed to initialize severity provider', error);
            throw error;
        }
    }

    /**
     * Get severity for a Checkov check ID - compatible with existing interface
     */
    getSeverity(checkovId: string): SeverityLevel | null {
        if (!this.isInitialized) {
            this.logError('Severity provider not initialized. Call initialize() first.');
            return null;
        }

        const severity = this.mappings.get(checkovId.toUpperCase()) || null;
        this.log(`Severity lookup for ${checkovId}: ${severity}`);
        return severity;
    }

    /**
     * Load mappings from cache or fetch from GitHub
     */
    async loadMappings(): Promise<void> {
        if (!this.context) {
            throw new Error('Context not initialized. Call initialize() first.');
        }

        this.log('Loading severity mappings...');

        try {
            // Try to load from cache first
            const cached = await this.loadFromCache();
            if (cached && !this.isCacheExpired(cached)) {
                this.log('Using cached mappings');
                this.applyMappings(cached.data);
                this.lastUpdate = new Date(cached.cached_at);
                this.currentVersion = cached.version;
                return;
            }

            this.log('Cache miss or expired, fetching from GitHub');
            
            // Fetch from GitHub
            const freshMappings = await this.fetchFromGitHub();
            this.applyMappings(freshMappings);
            await this.saveToCache(freshMappings);
            
        } catch (error) {
            this.logError('Failed to load mappings from GitHub, falling back to bundled file', error);
            await this.loadFallbackMappings();
        }
    }

    /**
     * Check if newer version is available
     */
    async checkForUpdates(): Promise<boolean> {
        try {
            const releaseInfo = await this.fetchReleaseInfo();
            const currentTimestamp = this.lastUpdate?.toISOString();
            const isUpdateAvailable = releaseInfo.generated_at !== currentTimestamp;
            
            if (isUpdateAvailable) {
                this.log(`Update available: ${releaseInfo.version} (current: ${this.currentVersion})`);
            }
            
            return isUpdateAvailable;
        } catch (error) {
            this.logError('Failed to check for updates', error);
            return false;
        }
    }

    /**
     * Force refresh mappings from GitHub
     */
    async forceRefresh(): Promise<void> {
        this.log('Force refreshing mappings from GitHub');
        try {
            const freshMappings = await this.fetchFromGitHub();
            this.applyMappings(freshMappings);
            await this.saveToCache(freshMappings);
            this.log('Successfully refreshed mappings');
        } catch (error) {
            this.logError('Failed to force refresh mappings', error);
            throw error;
        }
    }

    /**
     * Get current statistics
     */
    getStatistics(): { totalMappings: number; lastUpdate: string | null; version: string | null } {
        return {
            totalMappings: this.mappings.size,
            lastUpdate: this.lastUpdate?.toISOString() || null,
            version: this.currentVersion
        };
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.updateCheckInterval) {
            clearInterval(this.updateCheckInterval);
            this.updateCheckInterval = null;
        }
        this.outputChannel.dispose();
    }

    // Private methods

    private async fetchFromGitHub(): Promise<CheckovMappings> {
        this.log('Fetching mappings from GitHub');
        
        const mappings = await this.downloadWithRetry(MAPPINGS_URL) as CheckovMappings;
        this.validateMappingsData(mappings);
        
        this.lastUpdate = new Date(mappings.metadata.timestamp);
        this.currentVersion = mappings.metadata.version;
        
        this.log(`Downloaded ${Object.keys(mappings.mappings).length} mappings (version: ${this.currentVersion})`);
        return mappings;
    }

    private async fetchReleaseInfo(): Promise<ReleaseInfo> {
        return await this.downloadWithRetry(RELEASE_INFO_URL) as ReleaseInfo;
    }

    private async downloadWithRetry(url: string, retries: number = MAX_RETRIES): Promise<unknown> {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                this.log(`Downloading from ${url} (attempt ${attempt}/${retries})`);
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

                const response = await fetch(url, {
                    headers: { 
                        'User-Agent': 'VSCode-Checkov-Extension/1.0',
                        'Accept': 'application/json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();
                this.log(`Successfully downloaded data from ${url}`);
                return data;

            } catch (error) {
                this.logError(`Download attempt ${attempt} failed`, error);
                
                if (attempt === retries) {
                    throw new Error(`Failed to download after ${retries} attempts: ${error}`);
                }

                // Exponential backoff
                const delay = Math.pow(2, attempt) * 1000;
                this.log(`Waiting ${delay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw new Error('Download failed after all retries');
    }

    private validateMappingsData(data: unknown): asserts data is CheckovMappings {
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid data: not an object');
        }

        const obj = data as Record<string, unknown>;

        if (!obj.metadata || !obj.mappings) {
            throw new Error('Invalid data structure: missing metadata or mappings');
        }

        const metadata = obj.metadata as Record<string, unknown>;
        if (typeof metadata.total_mappings !== 'number') {
            throw new Error('Invalid metadata: missing or invalid total_mappings');
        }

        if (typeof metadata.timestamp !== 'string') {
            throw new Error('Invalid metadata: missing or invalid timestamp');
        }

        if (typeof metadata.version !== 'string') {
            throw new Error('Invalid metadata: missing or invalid version');
        }

        const mappings = obj.mappings as Record<string, unknown>;
        const mappingsCount = Object.keys(mappings).length;
        if (mappingsCount === 0) {
            throw new Error('Invalid data: no mappings found');
        }

        // Validate severity values
        const validSeverities = Object.values(SeverityLevel);
        for (const [id, severity] of Object.entries(mappings)) {
            if (!validSeverities.includes(severity as SeverityLevel)) {
                throw new Error(`Invalid severity level: ${severity} for ${id}`);
            }
        }

        this.log(`Data validation passed: ${mappingsCount} mappings`);
    }

    private applyMappings(mappings: CheckovMappings): void {
        this.mappings.clear();
        
        for (const [checkovId, severity] of Object.entries(mappings.mappings)) {
            this.mappings.set(checkovId.toUpperCase(), severity);
        }

        this.lastUpdate = new Date(mappings.metadata.timestamp);
        this.currentVersion = mappings.metadata.version;
        
        this.log(`Applied ${this.mappings.size} severity mappings`);
    }

    private async loadFromCache(): Promise<CachedMappings | null> {
        if (!this.context) return null;

        try {
            const cached = this.context.globalState.get<CachedMappings>(CACHE_KEY);
            if (cached) {
                this.log(`Found cached mappings (version: ${cached.version}, cached: ${cached.cached_at})`);
            }
            return cached || null;
        } catch (error) {
            this.logError('Failed to load from cache', error);
            return null;
        }
    }

    private async saveToCache(mappings: CheckovMappings): Promise<void> {
        if (!this.context) return;

        try {
            const now = new Date();
            const expiresAt = new Date(now.getTime() + (CACHE_DURATION_HOURS * 60 * 60 * 1000));
            
            const cacheData: CachedMappings = {
                data: mappings,
                cached_at: now.toISOString(),
                version: mappings.metadata.version,
                expires_at: expiresAt.toISOString()
            };

            await this.context.globalState.update(CACHE_KEY, cacheData);
            this.log(`Saved mappings to cache (expires: ${expiresAt.toISOString()})`);
        } catch (error) {
            this.logError('Failed to save to cache', error);
        }
    }

    private isCacheExpired(cached: CachedMappings): boolean {
        const now = new Date();
        const expiresAt = new Date(cached.expires_at);
        const isExpired = now > expiresAt;
        
        if (isExpired) {
            this.log(`Cache expired: ${cached.expires_at} < ${now.toISOString()}`);
        }
        
        return isExpired;
    }

    private async loadFallbackMappings(): Promise<void> {
        this.log('Loading fallback severity mappings from bundled file');
        
        try {
            // Try different possible paths for the severity.json file
            const possiblePaths = [
                path.join(__dirname, 'db', 'severity.json'),
                path.join(__dirname, '..', 'db', 'severity.json'),
                path.join(__dirname, '..', 'src', 'db', 'severity.json')
            ];
            
            let severityFilePath: string | null = null;
            for (const testPath of possiblePaths) {
                if (fs.existsSync(testPath)) {
                    severityFilePath = testPath;
                    break;
                }
            }
            
            if (!severityFilePath) {
                throw new Error(`Fallback severity.json not found in any of the expected paths: ${possiblePaths.join(', ')}`);
            }
            
            this.log(`Loading fallback mappings from: ${severityFilePath}`);
            
            const severityData = fs.readFileSync(severityFilePath, 'utf8');
            const fallbackData = JSON.parse(severityData);
            
            // Convert legacy format to new format if needed
            const mappings = this.convertLegacyFormat(fallbackData);
            this.applyMappings(mappings);
            
            this.log(`Loaded ${this.mappings.size} fallback severity mappings`);
        } catch (error) {
            this.logError('Failed to load fallback mappings', error);
            // Set empty mappings as last resort
            this.mappings.clear();
            this.log('Using empty mappings as last resort');
        }
    }

    private convertLegacyFormat(legacyData: unknown): CheckovMappings {
        // Convert the existing severity.json format to the new CheckovMappings format
        const mappings: Record<string, SeverityLevel> = {};
        
        const data = legacyData as Record<string, unknown>;
        
        if (data.mappings && typeof data.mappings === 'object') {
            const legacyMappings = data.mappings as Record<string, unknown>;
            for (const [key, value] of Object.entries(legacyMappings)) {
                const severityValue = (value as string).toUpperCase();
                if (Object.values(SeverityLevel).includes(severityValue as SeverityLevel)) {
                    mappings[key] = severityValue as SeverityLevel;
                }
            }
        }

        const metadata = data.metadata as Record<string, unknown> | undefined;
        const exportMetadata = data.export_metadata as Record<string, unknown> | undefined;

        return {
            metadata: {
                version: (metadata?.version as string) || '1.0',
                timestamp: (exportMetadata?.exported_at as string) || new Date().toISOString(),
                total_mappings: Object.keys(mappings).length,
                generator_version: (exportMetadata?.exported_by as string) || 'fallback'
            },
            mappings
        };
    }

    private startBackgroundUpdateChecker(): void {
        // Check for updates every hour
        this.updateCheckInterval = setInterval(async () => {
            try {
                if (await this.checkForUpdates()) {
                    this.log('Update detected, refreshing mappings in background');
                    await this.loadMappings();
                    vscode.window.showInformationMessage('Checkov severity mappings updated');
                }
            } catch (error) {
                this.logError('Background update check failed', error);
            }
        }, UPDATE_CHECK_INTERVAL_HOURS * 60 * 60 * 1000);
    }

    private log(message: string): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        
        if (this.logger) {
            this.logger.debug(logMessage);
        }
        
        this.outputChannel.appendLine(logMessage);
    }

    private logError(message: string, error?: unknown): void {
        const timestamp = new Date().toISOString();
        const errorMessage = error ? `${message}: ${error}` : message;
        const logMessage = `[${timestamp}] ERROR: ${errorMessage}`;
        
        if (this.logger) {
            this.logger.error(message, { error });
        }
        
        this.outputChannel.appendLine(logMessage);
    }
}

// Global instance
let globalSeverityProvider: CheckovSeverityProvider | null = null;

/**
 * Get the global severity provider instance
 */
export function getSeverityProvider(): CheckovSeverityProvider {
    if (!globalSeverityProvider) {
        globalSeverityProvider = new CheckovSeverityProvider();
    }
    return globalSeverityProvider;
}

/**
 * Initialize the global severity provider
 */
export async function initializeSeverityProvider(context: vscode.ExtensionContext, logger?: Logger): Promise<void> {
    const provider = getSeverityProvider();
    await provider.initialize(context, logger);
}

/**
 * Dispose the global severity provider
 */
export function disposeSeverityProvider(): void {
    if (globalSeverityProvider) {
        globalSeverityProvider.dispose();
        globalSeverityProvider = null;
    }
}
