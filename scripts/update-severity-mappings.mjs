import { writeFile } from 'node:fs/promises';

const url = 'https://github.com/xargsuk/checkov-severity-mapper/releases/latest/download/checkov_severity_mappings.json';
const destination = new URL('../resources/checkov_severity_mappings.json', import.meta.url);

const response = await fetch(url);
if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${url}`);
}
const text = await response.text();
const mappingCount = Object.keys(JSON.parse(text).mappings ?? {}).length;
if (mappingCount === 0) {
    throw new Error(`${url} has no mappings`);
}
await writeFile(destination, text);
console.log(`Saved ${mappingCount} severity mappings to ${destination.pathname}`);
