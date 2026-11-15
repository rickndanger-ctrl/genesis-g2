import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const palette = ['#4285ff','#9965ed','#ed66ad','#f29b43','#55b96d','#50bfd7'];
const providers = new Set(['codex','claude']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9._:-]{1,256}$/;
const networkRoutes = new Set(['/','/index.html','/healthz','/api/status','/api/profile','/api/chats',
  '/api/reply','/api/open','/api/diagnostics','/api/network-diagnostics']);
function networkPath(pathname) {
  if (networkRoutes.has(pathname)) return pathname;
  if (pathname.startsWith('/api/')) return '/api/other';
  if (pathname.startsWith('/assets/')) return '/assets/*';
  return '/static/other';
}
function networkOrigin(value) {
  if (value === undefined) return 'absent';
  if (value === 'null') return 'null';
  if (typeof value !== 'string' || value.length > 2048) return 'invalid';
  try {
    const parsed = new URL(value);
    // Never retain credentials, a path, a query, fragments, or opaque origins.
    return ['https:','http:'].includes(parsed.protocol) && parsed.origin === value ? parsed.origin : 'invalid';
  } catch { return 'invalid'; }
}
export class Fault extends Error {
  constructor(status, code, message) { super(message); Object.assign(this,{status,code}); }
}
function fault(status, code, message) { throw new Fault(status,code,message); }
function providerOf(value) {
  if (!providers.has(value)) fault(422,'invalid_provider','Choose Codex or Claude.');
  return value;
}
function chatID(value, provider) {
  if (typeof value !== 'string' || !(provider === 'codex' ? uuid : opaque).test(value))
    fault(422,'invalid_chat','Choose a valid assigned chat.');
  return provider === 'codex' ? value.toLowerCase() : value;
}
function tokenMatches(value, token) {
  const a=Buffer.from(value ?? ''), b=Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a,b);
}
function safeLabel(value, fallback='') { return typeof value === 'string' ? value.slice(0,240) : fallback; }
function cleanChat(row, provider) {
  if (!row || typeof row !== 'object') return null;
  try { return {id:chatID(row.id,provider),title:safeLabel(row.title,'Untitled chat'),state:safeLabel(row.state,'unknown')}; }
  catch { return null; }
}
async function readJSONBody(request) {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
    fault(415,'json_required','This action requires JSON.');
  let bytes=0; const parts=[];
  for await (const part of request) {
    bytes += part.length;
    if (bytes > 8192) fault(413,'request_too_large','Request is too large.');
    parts.push(part);
  }
  try { const value=JSON.parse(Buffer.concat(parts).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; }
  catch { fault(400,'invalid_json','Request could not be read.'); }
}

export function createBridge(config, dependencies={}) {
  if (typeof config.token !== 'string' || config.token.length < 32) throw Error('A private pairing token is required.');
  const allowedOrigins = new Set(config.allowedOrigins ?? []);
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['https:','http:'].includes(parsed.protocol) ||
      (parsed.protocol === 'http:' && !['localhost','127.0.0.1'].includes(parsed.hostname))) throw Error('Invalid allowed origin.');
  }
  const upstreamURL = config.upstreamURL ?? 'http://127.0.0.1:18765';
  const upstreamAddress = new URL(upstreamURL);
  if (upstreamAddress.protocol !== 'http:' || upstreamAddress.hostname !== '127.0.0.1' || upstreamAddress.username || upstreamAddress.password || upstreamAddress.pathname !== '/') throw Error('Upstream must be the local Genesis companion.');
  const fetcher=dependencies.fetch ?? fetch;
  let openBusy=false;
  const replyFlights=new Map();
  const replyCache=new Map();
  const diagnostics=[];
  const networkRequests=[];
  const networkNow=dependencies.diagnosticNow ?? Date.now;
  function pruneNetworkRequests() {
    const cutoff=networkNow()-15*60_000;
    for (let index=networkRequests.length-1;index>=0;index--)
      if (networkRequests[index].timestamp<=cutoff) networkRequests.splice(index,1);
  }
  const diagnosticEvents=new Set(['boot','bridge_ready','bridge_timeout','device_status','device_timeout','page_ack','page_failed','input','input_rejected','connected','disconnected','mac_status']);
  const diagnosticFields=new Set(['native','phase','status','connected','ack','source','eventType','index','containerID','expectedID','reason','sequence','deviceConnected']);
  async function upstream(path, options={}) {
    try {
      const token=dependencies.upstreamToken ?? (await readFile(config.upstreamTokenFile,'utf8')).trim();
      const response=await fetcher(upstreamURL+path, {
        ...options, redirect:'error', signal:AbortSignal.timeout(12_000),
        headers:{'Authorization':`Bearer ${token}`,...(options.body ? {'Content-Type':'application/json'} : {})}
      });
      if (!response.ok) fault(response.status === 401 ? 503 : 502,'companion_unavailable','The Mac companion could not complete this request. Open Genesis on this Mac and refresh.');
      const body=await response.text();
      if (Buffer.byteLength(body)>2_097_152) fault(502,'invalid_response','The Mac returned too much data.');
      return JSON.parse(body);
    } catch (error) {
      if (error instanceof Fault) throw error;
      fault(503,'companion_unavailable','Open the Genesis Mac companion, then try again.');
    }
  }
  async function hostStatus() {
    const status=await upstream('/v1/status');
    if (!uuid.test(status?.hostID ?? '') || !Array.isArray(status.providers)) fault(502,'invalid_response','The companion returned an unsupported status.');
    return status;
  }
  async function chats(provider) {
    const data=await upstream('/v1/chats?provider='+provider);
    if (!Array.isArray(data.chats)) fault(502,'invalid_response','The chat list is unavailable.');
    const rows=data.chats.slice(0,500).map(row=>cleanChat(row,provider)).filter(Boolean);
    const ids=new Set();
    for (const row of rows) { if (ids.has(row.id)) fault(409,'ambiguous_chat','The Mac returned an ambiguous chat list. Refresh before selecting.'); ids.add(row.id); }
    return rows;
  }
  async function profile(provider) {
    const value=await upstream('/v1/profile?provider='+provider);
    if (!Array.isArray(value.slots) || value.slots.length!==6) fault(502,'invalid_response','The six-slot mapping is unavailable.');
    const slots=Array.from({length:6},(_,index)=> {
      const matches=value.slots.filter(row=>row.index===index);
      if (matches.length!==1) fault(502,'invalid_response','The slot mapping is invalid.');
      const row=matches[0], kind=row.kind==='chat' ? 'chat' : row.kind==='action' ? 'shortcut' : 'empty';
      const id=kind==='chat' ? chatID(row.targetID,provider) : null;
      return {slot:index+1,label:safeLabel(row.title),title:safeLabel(row.title),chatID:id,kind,color:palette[index],...(kind==='shortcut' ? {action:safeLabel(row.targetID)} : {})};
    });
    return {provider,revision:value.revision,slots};
  }
  async function readReply(id) {
    if (dependencies.readReply) return dependencies.readReply(id);
    try {
      const {stdout}=await execFileAsync(config.readerPath ?? resolve(root,'bridge/bin/codex-reader'),['--thread',id],{
        timeout:15_000,maxBuffer:2_097_152,encoding:'utf8',windowsHide:true
      });
      return JSON.parse(stdout);
    } catch {
      fault(503,'reader_unavailable','This Codex reply could not be read. Keep the chat open on the Mac and refresh.');
    }
  }
  async function reply(id) {
    const cached=replyCache.get(id);
    if (cached && Date.now()-cached.at < 1500) return cached.value;
    if (replyFlights.has(id)) return replyFlights.get(id);
    if (replyFlights.size >= 2) fault(429,'reader_busy','Another reply is loading. Try again in a moment.');
    const flight=(async()=> {
      const source=await readReply(id);
      if (source?.ok!==true || source.provider!=='codex' || source.threadId?.toLowerCase()!==id)
        fault(503,'reply_unavailable','No verified reply is available for this thread.');
      const raw=source.reply?.text ?? '';
      if (typeof raw !== 'string') fault(502,'invalid_response','The reply format is unsupported.');
      const characters=Array.from(raw), text=characters.slice(0,16000).join('');
      // Phase describes this message, not whether the thread is currently done.
      // Keep unknown explicit when the reader could not identify its phase.
      const phase=text.trim() && ['final_answer','partial_answer','commentary','unknown'].includes(source.reply?.phase)
        ? source.reply.phase : undefined;
      const value={provider:'codex',chatID:id,title:safeLabel(source.title),text,
        ...(phase ? {phase} : {}),
        revision:createHash('sha256').update(id+'\n'+text+'\n'+(phase ?? '')).digest('hex').slice(0,20),
        updatedAt:new Date().toISOString(),status:['working','done','idle'].includes(source.state) ? source.state : 'unknown',
        truncated:characters.length>16000 || source.reply?.truncated===true || source.limited===true};
      replyCache.set(id,{at:Date.now(),value});
      if (replyCache.size>12) replyCache.delete(replyCache.keys().next().value);
      return value;
    })().finally(()=>replyFlights.delete(id));
    replyFlights.set(id,flight); return flight;
  }
  function json(response,status,value,extra={}) {
    response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...extra});
    response.end(JSON.stringify(value));
  }
  const server=http.createServer(async(request,response)=> {
    let cors={};
    let route='invalid', excludeNetworkDiagnostic=false;
    const method=['GET','POST','OPTIONS'].includes(request.method) ? request.method : 'other';
    const observedOrigin=networkOrigin(request.headers.origin);
    response.once('finish',()=> {
      if (excludeNetworkDiagnostic) return;
      pruneNetworkRequests();
      networkRequests.push({method,path:route,responseStatus:response.statusCode,origin:observedOrigin,timestamp:networkNow()});
      if (networkRequests.length>64) networkRequests.splice(0,networkRequests.length-64);
    });
    try {
      const target=new URL(request.url,'http://127.0.0.1');
      route=networkPath(target.pathname);
      excludeNetworkDiagnostic=target.pathname==='/api/network-diagnostics' && request.method==='GET';
      const origin=request.headers.origin;
      if (origin!==undefined) {
        if (!allowedOrigins.has(origin)) fault(403,'origin_denied','This app origin has not been paired with Genesis G2.');
        cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin'};
      }
      if (target.pathname==='/healthz' && request.method==='GET') return json(response,200,{ok:true,app:'Genesis G2',version:'0.1.0'},cors);
      if (target.pathname.startsWith('/api/')) {
        if (request.method==='OPTIONS') {
          if (!origin || !['GET','POST'].includes(request.headers['access-control-request-method'])) fault(403,'preflight_denied','This request is not allowed.');
          const requested=(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
          if (requested.some(x=>!['authorization','content-type'].includes(x))) fault(403,'preflight_denied','This request is not allowed.');
          response.writeHead(204,{...cors,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'300'}); return response.end();
        }
        if (!tokenMatches(request.headers.authorization,config.token)) fault(401,'not_paired','Pair Genesis G2 with this Mac first.');
        if (target.pathname==='/api/network-diagnostics' && request.method==='GET') {
          pruneNetworkRequests();
          return json(response,200,{requests:networkRequests},cors);
        }
        if (target.pathname==='/api/diagnostics' && request.method==='GET') {
          const cutoff=Date.now()-15*60_000;
          return json(response,200,{events:diagnostics.filter(row=>row.receivedAt>=cutoff)},cors);
        }
        if (target.pathname==='/api/diagnostics' && request.method==='POST') {
          const body=await readJSONBody(request);
          if (Object.keys(body).some(key=>!['session','events'].includes(key)) || !uuid.test(body.session ?? '') || !Array.isArray(body.events) || body.events.length>32)
            fault(422,'invalid_diagnostic','Invalid connection diagnostic.');
          const rows=body.events.map(row=>{
            if (!row || Object.keys(row).some(key=>!['seq','at','event','data'].includes(key)) || !diagnosticEvents.has(row.event) || !Number.isSafeInteger(row.seq) || row.seq<0 || row.seq>1_000_000 || !Number.isSafeInteger(row.at) || row.at<0 || !row.data || typeof row.data!=='object' || Array.isArray(row.data))
              fault(422,'invalid_diagnostic','Invalid connection diagnostic.');
            const entries=Object.entries(row.data);
            if (entries.some(([key,value])=>!diagnosticFields.has(key) || !Number.isInteger(value) || value < -1 || value>2147483647)) fault(422,'invalid_diagnostic','Only connection counters are accepted.');
            return {session:body.session,seq:row.seq,at:row.at,event:row.event,data:Object.fromEntries(entries),receivedAt:Date.now()};
          });
          diagnostics.push(...rows);
          if (diagnostics.length>128) diagnostics.splice(0,diagnostics.length-128);
          return json(response,200,{ok:true},cors);
        }
        if (request.method==='GET' && target.pathname==='/api/status') {
          const source=await hostStatus();
          return json(response,200,{version:'0.1.0',host:{id:source.hostID,name:config.name ?? source.hostName},providers:source.providers.filter(p=>providers.has(p.id)).map(p=>({
            id:p.id,label:safeLabel(p.name,p.id),available:p.readiness==='ready' && p.capabilities?.includes('openChat')===true,
            canReadReply:p.id==='codex' && p.readiness==='ready',reason:safeLabel(p.reason)
          }))},cors);
        }
        const provider=providerOf(target.searchParams.get('provider') ?? 'codex');
        if (request.method==='GET' && target.pathname==='/api/profile') return json(response,200,await profile(provider),cors);
        if (request.method==='GET' && target.pathname==='/api/chats') return json(response,200,{provider,chats:await chats(provider)},cors);
        if (request.method==='GET' && target.pathname==='/api/reply') {
          if (provider!=='codex') fault(501,'reader_unavailable','Claude chat switching is available. Reading Claude replies is not connected in this preview.');
          const id=chatID(target.searchParams.get('chatID'),provider);
          const source=await hostStatus();
          if (!source.providers.some(p=>p.id==='codex' && p.readiness==='ready')) fault(503,'provider_unavailable','Open Codex on the unlocked Mac to read its reply.');
          if (!(await chats(provider)).some(row=>row.id===id)) fault(404,'chat_missing','This chat is not in the current account. Refresh your mappings.');
          return json(response,200,await reply(id),cors);
        }
        if (request.method==='POST' && target.pathname==='/api/open') {
          if (openBusy) fault(409,'open_busy','A chat is already opening. Wait before selecting another.');
          const body=await readJSONBody(request);
          if (Object.keys(body).some(k=>!['provider','chatID','slot'].includes(k))) fault(422,'invalid_action','Only chat selection is available here.');
          const selectedProvider=providerOf(body.provider), id=chatID(body.chatID,selectedProvider);
          // Reading a streaming body yields; another selection may have acquired
          // the lease meanwhile. Keep this check and assignment synchronous.
          if (openBusy) fault(409,'open_busy','A chat is already opening. Wait before selecting another.');
          openBusy=true;
          try {
            const source=await hostStatus(), capability=source.providers.find(p=>p.id===selectedProvider);
            if (capability?.readiness!=='ready' || !capability.capabilities?.includes('openChat')) fault(503,'provider_unavailable','Open the selected provider on the unlocked Mac first.');
            const selected=(await chats(selectedProvider)).find(row=>row.id===id);
            if (!selected) fault(404,'chat_missing','This chat is unavailable. Refresh your mappings.');
            if (body.slot!==undefined) {
              if (!Number.isInteger(body.slot) || body.slot<1 || body.slot>6) fault(422,'invalid_slot','Choose a valid slot.');
              const assigned=(await profile(selectedProvider)).slots[body.slot-1];
              if (assigned.kind!=='chat' || assigned.chatID!==id) fault(409,'mapping_changed','This slot changed. Refresh before opening it.');
            }
            const receipt=await upstream('/v1/commands',{method:'POST',body:JSON.stringify({id:randomUUID(),hostID:source.hostID,provider:selectedProvider,chatID:id,action:'openChat',generation:0})});
            if (receipt.status!=='confirmed') fault(409,'open_unconfirmed','The Mac could not confirm this selection. Check the chat and refresh.');
            return json(response,200,{ok:true,chat:selected,status:selectedProvider==='codex' ? 'requested' : 'confirmed'},cors);
          } finally { openBusy=false; }
        }
        fault(404,'not_found','This action is not available in Genesis G2.');
      }
      if (!['GET','HEAD'].includes(request.method)) fault(405,'method_not_allowed','This method is not available.');
      let pathname;
      try { pathname=decodeURIComponent(target.pathname); } catch { fault(400,'invalid_path','Invalid path.'); }
      const staticRoot=await realpath(config.distPath ?? resolve(root,'dist'));
      const path=resolve(staticRoot,'.'+(pathname==='/' ? '/index.html' : pathname));
      const actual=await realpath(path).catch(()=>null);
      if (!actual || !actual.startsWith(staticRoot+sep) || !(await stat(actual)).isFile()) fault(404,'not_found','Page not found.');
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'}[extname(actual)] ?? 'application/octet-stream';
      response.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...cors});
      response.end(request.method==='HEAD' ? undefined : await readFile(actual));
    } catch (error) {
      if (response.headersSent) return response.destroy();
      const status=error instanceof Fault ? error.status : 500;
      json(response,status,{error:{code:error instanceof Fault ? error.code : 'internal_error',message:error instanceof Fault ? error.message : 'Genesis G2 could not complete this request.'}},cors);
    }
  });
  server.requestTimeout=20_000; server.headersTimeout=10_000; server.keepAliveTimeout=5_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const configPath=process.env.GENESIS_G2_CONFIG;
  if (!configPath) { process.stderr.write('Set GENESIS_G2_CONFIG to the private config file.\n'); process.exit(1); }
  try {
    const config=JSON.parse(await readFile(configPath,'utf8'));
    const server=createBridge(config);
    server.on('error',()=>{process.stderr.write('Genesis G2 could not listen on its local port.\n');process.exitCode=1;});
    server.listen(config.port ?? 18767,'127.0.0.1',()=>process.stdout.write('Genesis G2 bridge ready on loopback.\n'));
  } catch { process.stderr.write('Genesis G2 configuration is unavailable or invalid.\n'); process.exitCode=1; }
}
