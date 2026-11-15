// A local manifest has an exact origin but never a pairing token.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(homedir(), 'Library/Application Support/Genesis G2/config.json'), 'utf8'));
const origin = new URL(config.publicOrigin);
if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) throw Error('An exact HTTPS origin is required.');
const manifest = JSON.parse(await readFile(resolve(root, 'app.json'), 'utf8'));
manifest.permissions.find(permission => permission.name === 'network').whitelist = [origin.origin];
await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
await writeFile(resolve(root, '.local/app.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
process.stdout.write('Private build manifest prepared with one exact HTTPS origin and no token.\n');
