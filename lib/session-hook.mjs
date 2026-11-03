// Kept for run tabs opened before Orchestra lost its server: their hooks still call this file.
// It does what bin/hook.mjs does. Tabs opened (or reopened) now call bin/hook.mjs directly.
import fs from 'node:fs';
import { handle, print } from './hook-handler.mjs';

const event = process.argv[2] || '';
let body = {};
try {
  body = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {}

print(event, await handle(event, body));
process.exit(0);
