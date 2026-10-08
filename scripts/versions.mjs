import fs from 'node:fs';
export const VERSION=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
// Storage and wire compatibility versions are independent of the package release.
export const SCHEMA_VERSION=4;
export const ARCHITECTURE='opus-lead-v0.3';
export const PROTOCOL='hyperfusion-opus-lead-v0.5';
