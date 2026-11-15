import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const value=flag=>{const index=args.indexOf(flag);return index<0 ? undefined : args[index+1];};
const origin=value('--origin');
const name=value('--name') ?? 'Mini 2';
if (!origin || new URL(origin).origin!==origin || new URL(origin).protocol!=='https:') throw Error('Use --origin with the exact private Tailscale HTTPS origin.');
const directory=resolve(homedir(),'Library/Application Support/Genesis G2');
await mkdir(directory,{recursive:true,mode:0o700}); await chmod(directory,0o700);
const path=resolve(directory,'config.json');
let previous={};
try {previous=JSON.parse(await readFile(path,'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
const token=previous.token ?? randomBytes(32).toString('base64url');
// Retain exact origins verified during installed-Beta pairing. Re-running setup
// must not silently disconnect a known packaged Even WebView.
const allowedOrigins=[...new Set([...(previous.allowedOrigins ?? []),origin,'http://127.0.0.1:18767','http://localhost:18767'])];
const config={...previous,name,token,port:18767,publicOrigin:origin,allowedOrigins,
  originRecoveryPath:previous.originRecoveryPath ?? resolve(directory,'origin-recovery.json'),
  claudeReaderEnabled:previous.claudeReaderEnabled ?? true,
  upstreamURL:'http://127.0.0.1:18765',upstreamTokenFile:resolve(homedir(),'Library/Application Support/Genesis Agent Micro Controller/Remote/pairing-token'),
  distPath:resolve(root,'dist'),readerPath:resolve(root,'bridge/bin/codex-reader')};
await readFile(config.upstreamTokenFile,'utf8');
await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});await chmod(path,0o600);
const payload=Buffer.from(JSON.stringify({v:1,name,baseURL:origin,token})).toString('base64url');
const pairingFile=resolve(directory,'pairing-url.txt');
await writeFile(pairingFile,`${origin}/#pair=${payload}\n`,{mode:0o600});await chmod(pairingFile,0o600);
process.stdout.write('Private Genesis G2 configuration and pairing file saved. No token was printed.\n');
