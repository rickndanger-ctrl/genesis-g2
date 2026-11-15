import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createBridge } from '../bridge/server.mjs';

const token='fixture-only-g2-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const id='11111111-1111-4111-8111-111111111111';
const second='22222222-2222-4222-8222-222222222222';
const hostID='33333333-3333-4333-8333-333333333333';
const origin='https://example.test:8453';
const profile={provider:'codex',revision:1,slots:Array.from({length:6},(_,index)=>({index,kind:index===0 ? 'chat' : index===1 ? 'action' : 'empty',title:index===0 ? 'First thread' : index===1 ? 'Send prompt' : '',targetID:index===0 ? id : index===1 ? 'sendPrompt' : ''}))};
async function fixture(t, options={}) {
  const commands=[],reads=[];
  const directory=await mkdtemp(join(tmpdir(),'genesis-g2-test-'));
  await writeFile(join(directory,'index.html'),'<title>Genesis G2</title>');
  const server=createBridge({token,allowedOrigins:[origin],distPath:directory}, {
    upstreamToken:'fixture-upstream-token',
    diagnosticNow:options.diagnosticNow,
    fetch:async(url,init)=> {
      assert.equal(init.headers.Authorization,'Bearer fixture-upstream-token');
      assert.equal(new URL(url).origin,'http://127.0.0.1:18765');
      if (options.upstream) return options.upstream(url,init);
      const path=new URL(url).pathname;
      let result;
      if (path==='/v1/status') result={hostID,hostName:'Fixture Mac',providers:[{id:'codex',name:'Codex',readiness:'ready',capabilities:['openChat']},{id:'claude',name:'Claude',readiness:'ready',capabilities:['openChat']}]};
      else if (path==='/v1/chats') result={chats:[{id,title:'First thread',state:'Saved'},{id:second,title:'Second thread',state:'Saved'}]};
      else if (path==='/v1/profile') result=profile;
      else if (path==='/v1/commands') { commands.push(JSON.parse(init.body)); if (options.commandDelay) await new Promise(resolve=>setTimeout(resolve,options.commandDelay)); result={status:'confirmed'}; }
      else throw Error('Unexpected upstream operation');
      return new Response(JSON.stringify(result),{status:200});
    },
    readReply:async(value)=> {
      reads.push(value);
      if (options.reader) return options.reader(value);
      return {ok:true,provider:'codex',threadId:value,title:'First thread',state:'unknown',reply:{text:'A verified reply.',phase:'final_answer'}};
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const request=(path,init={})=>fetch(base+path,{...init,headers:{Authorization:`Bearer ${token}`,...init.headers}});
  return {request,commands,reads,base};
}
test('private API rejects missing credentials and wrong origins before upstream requests',async t=>{
  const {base,request}=await fixture(t);
  assert.equal((await fetch(base+'/api/status')).status,401);
  assert.equal((await request('/api/status',{headers:{Origin:'https://untrusted.test'}})).status,403);
  assert.equal((await request('/api/status',{headers:{Origin:'null'}})).status,403);
  const response=await request('/api/status',{headers:{Origin:origin}});
  assert.equal(response.status,200); assert.equal(response.headers.get('access-control-allow-origin'),origin);
  const data=await response.json(); assert.equal(data.host.id,hostID); assert.equal(data.providers[1].canReadReply,false);
});
test('CORS preflight allows only paired origins and supported request headers',async t=>{
  const {request}=await fixture(t);
  const headers={Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type'};
  assert.equal((await request('/api/open',{method:'OPTIONS',headers})).status,204);
  assert.equal((await request('/api/open',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Headers':'X-Execute'}})).status,403);
  assert.equal((await request('/api/open',{method:'OPTIONS',headers:{...headers,'Access-Control-Request-Method':'DELETE'}})).status,403);
});
test('connection diagnostics stay authenticated, numeric, bounded, and non-executing',async t=>{
  const {request,base,commands,reads}=await fixture(t);
  const post=body=>request('/api/diagnostics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/diagnostics')).status,401);
  const event={seq:0,at:Date.now(),event:'boot',data:{native:1}};
  assert.equal((await post({session:id,events:[event]})).status,200);
  assert.equal((await post({session:id,events:[{...event,data:{text:'private contents'}}]})).status,422);
  assert.equal((await post({session:id,events:[{...event,event:'private contents'}]})).status,422);
  assert.equal((await post({session:id,events:[event],token:'anything'})).status,422);
  assert.equal((await post({session:id,events:Array(33).fill(event)})).status,422);
  for(let batch=0;batch<5;batch++) assert.equal((await post({session:id,events:Array.from({length:32},(_,i)=>({...event,seq:batch*32+i}))})).status,200);
  const result=await (await request('/api/diagnostics')).json();
  assert.equal(result.events.length,128);
  assert.deepEqual(result.events.at(-1).data,{native:1});
  assert.equal(result.events.at(-1).seq,159);
  assert.equal(commands.length,0);assert.equal(reads.length,0);
});
test('passive network diagnostics require authentication and exclude diagnostic reads themselves',async t=>{
  const {request,base,commands,reads}=await fixture(t);
  assert.equal((await fetch(base+'/api/network-diagnostics')).status,401);
  assert.equal((await request('/api/network-diagnostics',{headers:{Origin:'https://untrusted.test'}})).status,403);
  const first=await request('/api/network-diagnostics');
  assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
  assert.deepEqual(await first.json(),{requests:[]});
  assert.equal((await request('/healthz')).status,200);
  const observed=await (await request('/api/network-diagnostics')).json();
  assert.equal(observed.requests.length,1);
  assert.deepEqual(Object.keys(observed.requests[0]).sort(),['method','origin','path','responseStatus','timestamp']);
  assert.equal(observed.requests[0].path,'/healthz');
  assert.equal(observed.requests[0].method,'GET');
  assert.equal(observed.requests[0].origin,'absent');
  assert.equal(observed.requests[0].responseStatus,200);
  assert.equal(Number.isSafeInteger(observed.requests[0].timestamp),true);
  assert.deepEqual(await (await request('/api/network-diagnostics')).json(),observed);
  assert.equal(commands.length,0);assert.equal(reads.length,0);
});
test('network trace captures denied preflights and static requests without private request data',async t=>{
  const {request,base,commands,reads}=await fixture(t);
  const privateValue='private-query-body-and-header-value';
  assert.equal((await request('/api/open?chatID='+id,{method:'OPTIONS',headers:{Origin:'https://unpaired.test','Access-Control-Request-Method':'POST'}})).status,403);
  assert.equal((await request('/api/open',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'X-Private'}})).status,403);
  assert.equal((await fetch(base+'/api/status?token='+privateValue,{headers:{Authorization:privateValue,'User-Agent':privateValue,'X-Forwarded-For':'192.0.2.123'}})).status,401);
  assert.equal((await request('/?token='+privateValue+'&chatID='+id)).status,200);
  assert.equal((await request('/assets/'+privateValue+'.js?chatID='+id)).status,404);
  assert.equal((await request('/api/'+privateValue+'?chatID='+id)).status,404);
  assert.equal((await request('/'+privateValue,{method:'DELETE'})).status,405);
  assert.equal((await request('/api/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'codex',chatID:id,text:privateValue})})).status,422);
  const data=await (await request('/api/network-diagnostics')).json();
  assert.deepEqual(data.requests.map(({method,path,responseStatus,origin})=>({method,path,responseStatus,origin})),[
    {method:'OPTIONS',path:'/api/open',responseStatus:403,origin:'https://unpaired.test'},
    {method:'OPTIONS',path:'/api/open',responseStatus:403,origin},
    {method:'GET',path:'/api/status',responseStatus:401,origin:'absent'},
    {method:'GET',path:'/',responseStatus:200,origin:'absent'},
    {method:'GET',path:'/assets/*',responseStatus:404,origin:'absent'},
    {method:'GET',path:'/api/other',responseStatus:404,origin:'absent'},
    {method:'other',path:'/static/other',responseStatus:405,origin:'absent'},
    {method:'POST',path:'/api/open',responseStatus:422,origin:'absent'}
  ]);
  const serialized=JSON.stringify(data);
  for (const secret of [privateValue,id,token,'fixture-upstream-token','192.0.2.123','User-Agent','Authorization'])
    assert.equal(serialized.includes(secret),false);
  assert.equal(commands.length,0);assert.equal(reads.length,0);
});
test('network origins contain only exact URL origins or fixed safe markers',async t=>{
  const {request}=await fixture(t);
  const origins=['null','not a URL','https://user:secret@origin.test','https://origin.test/path',
    'https://origin.test?token=secret','https://origin.test#secret','file:///private/home','https://one.test https://two.test',origin];
  for (const value of origins) await request('/healthz',{headers:{Origin:value}});
  const data=await (await request('/api/network-diagnostics')).json();
  assert.deepEqual(data.requests.map(row=>row.origin),['null','invalid','invalid','invalid','invalid','invalid','invalid','invalid',origin]);
  assert.equal(JSON.stringify(data).includes('secret'),false);
  assert.equal(JSON.stringify(data).includes('private/home'),false);
});
test('network trace retains only the latest 64 responses and expires after fifteen minutes',async t=>{
  let now=1_800_000_000_000;
  const {request}=await fixture(t,{diagnosticNow:()=>now});
  for(let index=0;index<70;index++) {now++;await request('/healthz?privateIndex='+index);}
  const data=await (await request('/api/network-diagnostics')).json();
  assert.equal(data.requests.length,64);
  assert.equal(data.requests[0].timestamp,1_800_000_000_007);
  assert.equal(data.requests.at(-1).timestamp,now);
  now+=15*60_000;
  assert.deepEqual(await (await request('/api/network-diagnostics')).json(),{requests:[]});
  await request('/healthz');
  const fresh=await (await request('/api/network-diagnostics')).json();
  assert.equal(fresh.requests.length,1);assert.equal(fresh.requests[0].timestamp,now);
});
test('profile preserves six slot identities and marks shortcuts instead of running them',async t=>{
  const {request,commands}=await fixture(t);
  const result=await (await request('/api/profile?provider=codex')).json();
  assert.equal(result.slots.length,6); assert.equal(result.slots[0].slot,1); assert.equal(result.slots[0].chatID,id);
  assert.equal(result.slots[1].kind,'shortcut'); assert.equal(result.slots[1].action,'sendPrompt');
  assert.equal(result.slots[5].kind,'empty'); assert.equal(commands.length,0);
});
test('open routes only the exact current-account chat and validates slot mapping',async t=>{
  const {request,commands}=await fixture(t);
  const post=body=>request('/api/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({provider:'codex',chatID:second,slot:1})).status,409);
  assert.equal(commands.length,0);
  assert.equal((await post({provider:'codex',chatID:id,action:'sendPrompt'})).status,422);
  assert.equal(commands.length,0);
  const response=await post({provider:'codex',chatID:id,slot:1});
  assert.equal(response.status,200); assert.equal((await response.json()).status,'requested');
  assert.equal(commands.length,1); assert.equal(commands[0].action,'openChat');
  assert.equal(commands[0].chatID,id); assert.equal(commands[0].hostID,hostID); assert.equal(commands[0].text,undefined);
});
test('reply is read-only, bounded and never makes up working status',async t=>{
  const {request,commands,reads}=await fixture(t);
  const data=await (await request('/api/reply?provider=codex&chatID='+id)).json();
  assert.equal(data.chatID,id); assert.equal(data.text,'A verified reply.'); assert.equal(data.status,'unknown');
  assert.equal(data.phase,'final_answer');
  assert.equal(commands.length,0); assert.deepEqual(reads,[id]);
  assert.equal((await request('/api/reply?provider=claude&chatID='+id)).status,501);
  assert.equal((await request('/api/reply?provider=codex&chatID=invalid')).status,422);
  assert.equal((await request('/api/reply?provider=codex&chatID=44444444-4444-4444-8444-444444444444')).status,404);
  assert.deepEqual(reads,[id]);
});
test('verified reply phase is independent from unknown runtime state',async t=>{
  for (const phase of ['final_answer','partial_answer','commentary','unknown']) {
    const {request,commands}=await fixture(t,{reader:async value=>({ok:true,provider:'codex',threadId:value,
      state:'notLoaded',reply:{text:'The latest assistant message.',phase}})});
    const response=await request('/api/reply?provider=codex&chatID='+id);
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.phase,phase);
    assert.equal(data.status,'unknown','message phase must not fabricate a runtime completion');
    assert.equal(commands.length,0);
  }
});
test('missing, unsupported, and empty reply phases are omitted instead of guessed',async t=>{
  for (const reply of [{text:'Legacy reply.'},{text:'Future reply.',phase:'finished'},
    {text:'Invalid phase.',phase:{type:'final_answer'}},{text:'   ',phase:'final_answer'},null]) {
    const {request}=await fixture(t,{reader:async value=>({ok:true,provider:'codex',threadId:value,state:'unknown',reply})});
    const response=await request('/api/reply?provider=codex&chatID='+id);
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(Object.hasOwn(data,'phase'),false);
    assert.equal(data.status,'unknown');
  }
});
test('progress and final messages with identical text have distinct revisions',async t=>{
  const revisions=[];
  for (const phase of ['commentary','final_answer']) {
    const {request}=await fixture(t,{reader:async value=>({ok:true,provider:'codex',threadId:value,
      state:'unknown',reply:{text:'The same message.',phase}})});
    const data=await (await request('/api/reply?provider=codex&chatID='+id)).json();
    revisions.push(data.revision);
  }
  assert.notEqual(revisions[0],revisions[1]);
});
test('two streaming request bodies cannot open competing chats concurrently',async t=>{
  const {base,commands}=await fixture(t,{commandDelay:50});
  const endings=[];
  const requests=[id,second].map(value=>new Promise((resolve,reject)=>{
    const body=JSON.stringify({provider:'codex',chatID:value});
    const request=http.request(base+'/api/open',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
      response.resume();response.on('end',()=>resolve(response.statusCode));
    });
    request.on('error',reject);request.flushHeaders();endings.push(()=>request.end(body));
  }));
  await new Promise(resolve=>setTimeout(resolve,20));
  endings.forEach(end=>end());
  assert.deepEqual((await Promise.all(requests)).sort(),[200,409]);
  assert.equal(commands.length,1);
});
test('wrong-thread reader response is rejected rather than displayed',async t=>{
  const {request}=await fixture(t,{reader:async()=>({ok:true,provider:'codex',threadId:second,reply:{text:'Wrong thread'}})});
  const response=await request('/api/reply?provider=codex&chatID='+id);
  assert.equal(response.status,503); assert.equal(JSON.stringify(await response.json()).includes('Wrong thread'),false);
});
test('concurrent reads share one request and oversized replies are clipped visibly',async t=>{
  let count=0;
  const {request}=await fixture(t,{reader:async value=>{count++;await new Promise(resolve=>setTimeout(resolve,30));return {ok:true,provider:'codex',threadId:value,reply:{text:'a'.repeat(17000)}};}});
  const responses=await Promise.all([request('/api/reply?chatID='+id),request('/api/reply?chatID='+id)]);
  assert.equal(count,1);
  for (const response of responses) {const data=await response.json();assert.equal(data.text.length,16000);assert.equal(data.truncated,true);}
});
test('filesystem and command surface stay restricted',async t=>{
  const {request,commands}=await fixture(t);
  assert.equal((await request('/')).status,200);
  assert.equal((await request('/%2e%2e/%2e%2e/etc/passwd')).status,404);
  assert.equal((await request('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
  assert.equal(commands.length,0);
});
test('upstream credentials and exception content never reach client errors',async t=>{
  const {request}=await fixture(t,{upstream:async()=>{throw Error('private token and user text');}});
  const response=await request('/api/status');
  assert.equal(response.status,503);
  const text=await response.text(); assert.equal(text.includes('private token'),false); assert.equal(text.includes('fixture-upstream-token'),false);
});
