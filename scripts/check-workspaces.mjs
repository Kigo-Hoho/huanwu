import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

if (!Array.isArray(manifest.workspaces)) {
  throw new Error('Root package.json must declare workspaces.');
}

console.log(`Configured workspaces: ${manifest.workspaces.join(', ')}`);
