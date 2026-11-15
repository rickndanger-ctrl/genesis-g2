// Installs only the standalone Genesis G2 bridge for this macOS login.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const label = 'com.pybird.genesis-g2.bridge';
const support = resolve(homedir(), 'Library/Application Support/Genesis G2');
const plist = resolve(homedir(), 'Library/LaunchAgents', label + '.plist');
const domain = `gui/${process.getuid()}`;
const run = (args, optional = false) => {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (!optional && result.status !== 0) throw Error('Could not update the Genesis G2 login service.');
};
if (process.argv.includes('--remove')) {
  run(['bootout', domain + '/' + label], true);
  const { unlink } = await import('node:fs/promises');
  await unlink(plist).catch(error => { if (error.code !== 'ENOENT') throw error; });
  process.stdout.write('Genesis G2 login service removed. Pairing and other apps were preserved.\n');
} else {
  const configPath = resolve(support, 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await readFile(resolve(config.distPath, 'index.html'));
  await readFile(config.readerPath);
  await mkdir(dirname(plist), { recursive: true });
  await mkdir(support, { recursive: true, mode: 0o700 });
  await chmod(support, 0o700);
  const xml = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const script = resolve(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string></array>
<key>EnvironmentVariables</key><dict><key>GENESIS_G2_CONFIG</key><string>${xml(configPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(resolve(support, 'bridge.log'))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(support, 'bridge-error.log'))}</string>
</dict></plist>\n`;
  await writeFile(plist, document, { mode: 0o600 });
  await chmod(plist, 0o600);
  run(['bootout', domain + '/' + label], true);
  run(['bootstrap', domain, plist]);
  process.stdout.write('Standalone Genesis G2 bridge installed for this macOS login.\n');
}
