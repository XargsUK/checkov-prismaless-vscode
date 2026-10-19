import { mkdir, writeFile } from 'node:fs/promises';

const url = 'https://github.com/xargsuk/checkov-severity-mapper/releases/latest/download/checkov_severity_mappings.json';
const destination = new URL('../resources/checkov_severity_mappings.json', import.meta.url);

const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
}
const severities = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const text = await response.text();
const entries = Object.entries(JSON.parse(text).mappings ?? {});
if (entries.length === 0) {
    throw new Error(`${url} has no mappings`);
}
const invalid = entries.find(([, severity]) => !severities.includes(severity));
if (invalid) {
    throw new Error(`${url} has an invalid severity ${invalid[1]} for ${invalid[0]}`);
}
await mkdir(new URL('.', destination), { recursive: true });
await writeFile(destination, text);
console.log(`Saved ${entries.length} severity mappings to ${destination.pathname}`);
