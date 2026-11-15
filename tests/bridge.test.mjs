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
  const commands=[],reads=[],feedback=[];
  const directory=await mkdtemp(join(tmpdir(),'genesis-g2-test-'));
  await writeFile(join(directory,'index.html'),'<title>Genesis G2</title>');
  const server=createBridge({token,allowedOrigins:[origin],distPath:directory}, {
    upstreamToken:'fixture-upstream-token',
    diagnosticNow:options.diagnosticNow,
    followNow:options.followNow,
    fetch:async(url,init)=> {
      assert.equal(init.headers.Authorization,'Bearer fixture-upstream-token');
      assert.equal(new URL(url).origin,'http://127.0.0.1:18765');
      if (options.upstream) return options.upstream(url,init);
      const path=new URL(url).pathname;
      let result;
      if (path==='/v1/status') result={hostID,hostName:'Fixture Mac',providers:[{id:'codex',name:'Codex',readiness:'ready',capabilities:['openChat']},{id:'claude',name:'Claude',readiness:'ready',capabilities:['openChat']}]};
      else if (path==='/v1/display-session') return options.follow ? options.follow() : new Response('{}',{status:404});
      else if (path==='/v1/display-feedback') { feedback.push(JSON.parse(init.body)); return options.feedback ? options.feedback() : options.follow(); }
      else if (path==='/v1/chats') result={chats:options.inventory ? options.inventory(new URL(url).searchParams.get('provider')) : [{id,title:'First thread',state:'Saved'},{id:second,title:'Second thread',state:'Saved'}]};
      else if (path==='/v1/profile') result=profile;
      else if (path==='/v1/commands') { commands.push(JSON.parse(init.body)); if (options.commandDelay) await new Promise(resolve=>setTimeout(resolve,options.commandDelay)); result={status:'confirmed'}; }
      else throw Error('Unexpected upstream operation');
      return new Response(JSON.stringify(result),{status:200});
    },
    ...(options.claudeReader ? {readClaudeReply:options.claudeReader} : {}),
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
  return {request,commands,reads,feedback,base};
}
const displayState={provider:'codex',chatID:id,slotIndex:0,view:'reply',page:0,draft:'',recording:false,sendState:'none',refreshNonce:0};
const followSnapshot=overrides=>({version:1,hostID,active:true,revision:2,sourceID:second,sourceName:'iPad',
  expiresAt:new Date(Date.now()+45000).toISOString(),chatTitle:'First thread',state:{...displayState},...overrides});
test('follow supports older companions and never exposes native ownership routes',async t=>{
  const {request,commands,reads,base}=await fixture(t);
  assert.equal((await fetch(base+'/api/follow')).status,401);
  assert.equal((await request('/api/follow',{headers:{Origin:'null'}})).status,403);
  const response=await request('/api/follow');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{supported:false,version:1,hostID,active:false,revision:0});
  assert.equal((await request('/api/follow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'claim'})})).status,404);
  assert.equal(commands.length,0);assert.equal(reads.length,0);
});
test('follow strips lease secrets and stale feedback while retaining exact native display target',async t=>{
  const source=followSnapshot({leaseID:'private-ownership-token',unexpected:'private',feedback:{revision:1,pageCount:3,renderedPage:0,connected:true}});
  const {request,commands,reads}=await fixture(t,{follow:()=>new Response(JSON.stringify(source))});
  const data=await (await request('/api/follow')).json();
  assert.equal(data.supported,true);assert.deepEqual(data.state,displayState);assert.equal(data.chatTitle,'First thread');
  assert.equal(data.feedback,undefined);assert.equal(data.leaseID,undefined);assert.equal(data.unexpected,undefined);
  assert.equal(commands.length,0);assert.equal(reads.length,0);
});
test('expired and inactive follow sessions cannot leak a draft',async t=>{
  for (const overrides of [{expiresAt:new Date(Date.now()-1).toISOString()}, {active:false}]) {
    const {request}=await fixture(t,{follow:()=>new Response(JSON.stringify(followSnapshot({...overrides,
      state:{...displayState,view:'draft',draft:'private text',recording:true}})))});
    assert.deepEqual(await (await request('/api/follow')).json(),{supported:true,version:1,hostID,active:false,revision:2});
  }
});
test('follow rejects cross-host targets, invalid states and oversized drafts',async t=>{
  for (const changes of [{hostID:id},{sourceName:'untrusted'}, {state:{...displayState,page:-1}},
    {state:{...displayState,chatID:null}}, {state:{...displayState,draft:'x'.repeat(16001)}},
    {state:{...displayState,action:'sendPrompt'}}, {state:{...displayState,sendState:'sent'}}]) {
    const {request}=await fixture(t,{follow:()=>new Response(JSON.stringify(followSnapshot(changes)))});
    const response=await request('/api/follow');assert.equal(response.status,502);
    assert.equal((await response.json()).error.code,'invalid_response');
  }
});
test('display feedback is closed, authenticated and never runs chat or send commands',async t=>{
  const source=followSnapshot({feedback:{revision:2,pageCount:3,renderedPage:0,connected:true}});
  const {request,base,feedback,commands,reads}=await fixture(t,{follow:()=>new Response(JSON.stringify(source))});
  const value={revision:2,provider:'codex',chatID:id,view:'reply',pageCount:3,renderedPage:0,connected:true};
  const init=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/follow-feedback',init(value))).status,401);
  for (const invalid of [{...value,text:'do something'},{...value,leaseID:second},{...value,renderedPage:3},
    {...value,pageCount:0},{...value,revision:-1},{...value,chatID:null}])
    assert.equal((await request('/api/follow-feedback',init(invalid))).status,422);
  assert.equal(feedback.length,0);
  const response=await request('/api/follow-feedback',init(value));assert.equal(response.status,200);
  assert.deepEqual(feedback,[value]);assert.deepEqual((await response.json()).feedback,source.feedback);
  assert.equal(commands.length,0);assert.equal(reads.length,0);
});
test('stale display feedback conflicts are not retried or treated as acknowledgments',async t=>{
  const {request,feedback}=await fixture(t,{feedback:()=>new Response('{}',{status:409})});
  const response=await request('/api/follow-feedback',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({revision:1,provider:'codex',chatID:id,view:'reply',pageCount:2,renderedPage:0,connected:true})});
  assert.equal(response.status,409);assert.equal(feedback.length,1);
  assert.equal((await response.json()).error.code,'display_changed');
});
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
test('Claude capability is enabled only when its reader is configured',async t=>{
  const {request}=await fixture(t,{claudeReader:async()=>{throw Error('unused');}});
  const data=await(await request('/api/status')).json();
  assert.equal(data.providers.find(row=>row.id==='claude').canReadReply,true);
});
test('Claude returns only verified conversation fields without executing actions',async t=>{
  const targets=[];
  const {request,commands,reads}=await fixture(t,{claudeReader:async target=>{
    targets.push(target);return {ok:true,provider:'claude',threadId:target.id,title:target.title,state:'unknown',reply:{text:'Claude reply',phase:'final_answer'},turns:[{role:'user',text:'My request'},{role:'assistant',text:'Claude reply',phase:'final_answer'}],privatePath:'do not expose'};
  }});
  const response=await request('/api/reply?provider=claude&chatID='+id);assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.provider,'claude');assert.equal(data.chatID,id);
  assert.deepEqual(targets,[{id,title:'First thread'}]);assert.deepEqual(data.turns.map(row=>row.role),['user','assistant']);
  assert.equal(data.privatePath,undefined);assert.equal(data.status,'unknown');assert.equal(commands.length,0);assert.equal(reads.length,0);
});
test('Claude rejects mismatched reader identities and does not leak their content',async t=>{
  for(const wrong of [{provider:'codex',threadId:id},{provider:'claude',threadId:second}]){
    const {request}=await fixture(t,{claudeReader:async()=>({ok:true,...wrong,reply:{text:'wrong private conversation'}})});
    const response=await request('/api/reply?provider=claude&chatID='+id);assert.equal(response.status,503);
    assert.equal((await response.text()).includes('wrong private conversation'),false);
  }
});
test('Claude and Codex replies never share a cache entry or in-flight request',async t=>{
  const {request}=await fixture(t,{claudeReader:async target=>({ok:true,provider:'claude',threadId:target.id,reply:{text:'Claude-only'}})});
  const values=await Promise.all(['codex','claude'].map(async provider=>(await request('/api/reply?provider='+provider+'&chatID='+id)).json()));
  assert.equal(values[0].text,'A verified reply.');assert.equal(values[1].text,'Claude-only');
  assert.notEqual(values[0].revision,values[1].revision);
});
test('Claude revalidates the inventory after reading and rejects renamed targets',async t=>{
  let count=0;
  const {request}=await fixture(t,{inventory:()=>[{id,title:++count===1 ? 'First thread' : 'Renamed thread'}],
    claudeReader:async target=>({ok:true,provider:'claude',threadId:target.id,reply:{text:'stale conversation'}})});
  const response=await request('/api/reply?provider=claude&chatID='+id);assert.equal(response.status,409);
  assert.equal((await response.text()).includes('stale conversation'),false);
});
test('repeated Claude reads revalidate local account/session instead of returning cached text',async t=>{
  let count=0;
  const {request}=await fixture(t,{claudeReader:async target=>({ok:true,provider:'claude',threadId:target.id,reply:{text:'Read '+(++count)}})});
  const first=await(await request('/api/reply?provider=claude&chatID='+id)).json();
  const secondRead=await(await request('/api/reply?provider=claude&chatID='+id)).json();
  assert.equal(first.text,'Read 1');assert.equal(secondRead.text,'Read 2');assert.equal(count,2);
});
test('Claude parser failures are sanitized and cannot reveal private paths or text',async t=>{
  const {request,commands}=await fixture(t,{claudeReader:async()=>{throw Error('/private/user/path secret transcript');}});
  const response=await request('/api/reply?provider=claude&chatID='+id);assert.equal(response.status,503);
  const body=await response.text();assert.equal(body.includes('/private/'),false);assert.equal(body.includes('secret transcript'),false);assert.equal(commands.length,0);
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
test('conversation exposes only bounded user and assistant fields without executing commands',async t=>{
  const turns=[{role:'user',text:'The actual request',phase:'final_answer',metadata:{private:'not exposed'}},
    {role:'assistant',text:'The actual reply',phase:'commentary',truncated:true,toolCall:'not exposed'}];
  const {request,commands}=await fixture(t,{reader:async value=>({ok:true,provider:'codex',threadId:value,
    reply:{text:'The actual reply',phase:'commentary'},turns,turnsTruncated:true})});
  const data=await(await request('/api/reply?provider=codex&chatID='+id)).json();
  assert.deepEqual(data.turns,[{role:'user',text:'The actual request'},{role:'assistant',text:'The actual reply',phase:'commentary',truncated:true}]);
  assert.equal(data.turnsTruncated,true);assert.equal(data.status,'unknown');assert.equal(commands.length,0);
});
test('conversation rejects non-display roles and oversized excerpts',async t=>{
  const cases=[...['system','developer','tool','reasoning'].map(role=>[{role,text:'not exposed'}]),
    [{role:'user',text:'x'.repeat(16001)}],Array.from({length:7},()=>({role:'user',text:'x'})),[{role:'user',text:{private:'not exposed'}}]];
  for(const turns of cases){
    const {request}=await fixture(t,{reader:async value=>({ok:true,provider:'codex',threadId:value,reply:{text:'Reply'},turns})});
    const response=await request('/api/reply?provider=codex&chatID='+id);assert.equal(response.status,502);
    assert.equal((await response.text()).includes('not exposed'),false);
  }
});
test('a new user message changes revision even before the assistant replies',async t=>{
  const revisions=[];
  for(const prompt of ['First request','New request']){
    const {request}=await fixture(t,{reader:async value=>({ok:true,provider:'codex',threadId:value,state:'unknown',
      reply:{text:'Existing final',phase:'final_answer'},turns:[{role:'assistant',text:'Existing final',phase:'final_answer'},{role:'user',text:prompt}]})});
    const data=await(await request('/api/reply?provider=codex&chatID='+id)).json();revisions.push(data.revision);
    assert.equal(data.status,'unknown');assert.equal(data.turns.at(-1).role,'user');
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
