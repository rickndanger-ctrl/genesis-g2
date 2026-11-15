// Closed, display-only boundary. Ownership tokens never cross into Even Hub.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaque=/^[A-Za-z0-9._:-]{1,256}$/;
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const integer=(value,min,max)=>Number.isSafeInteger(value) && value>=min && value<=max;
const provider=value=>['codex','claude'].includes(value);
const view=value=>['home','reply','draft'].includes(value);
const target=(id,p)=>id===null || (typeof id==='string' && (p==='codex' ? uuid : opaque).test(id));
const exact=(value,keys)=>object(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const stateKeys=['provider','chatID','slotIndex','view','page','draft','recording','sendState','refreshNonce'];
const feedbackKeys=['revision','provider','chatID','view','pageCount','renderedPage','connected'];
export class InvalidFollow extends Error {}
function requireValid(condition) { if (!condition) throw new InvalidFollow('Invalid display session.'); }

export function cleanFeedback(value) {
  requireValid(exact(value,feedbackKeys) && integer(value.revision,0,Number.MAX_SAFE_INTEGER) &&
    provider(value.provider) && target(value.chatID,value.provider) && view(value.view) &&
    (value.view==='home' || value.chatID!==null) && integer(value.pageCount,1,1000) &&
    integer(value.renderedPage,0,value.pageCount-1) && typeof value.connected==='boolean');
  return Object.fromEntries(feedbackKeys.map(key=>[key,value[key]]));
}

export function cleanFollow(value,hostID,now=Date.now()) {
  requireValid(object(value) && value.version===1 && typeof value.active==='boolean' &&
    uuid.test(value.hostID ?? '') && value.hostID.toLowerCase()===hostID.toLowerCase() &&
    integer(value.revision,0,Number.MAX_SAFE_INTEGER));
  const result={supported:true,version:1,hostID,active:value.active,revision:value.revision};
  if (!value.active) return result; // Explicitly discard drafts and stale ownership metadata.
  requireValid(uuid.test(value.sourceID ?? '') && ['iPhone','iPad'].includes(value.sourceName) &&
    typeof value.expiresAt==='string' && Number.isFinite(Date.parse(value.expiresAt)));
  if (Date.parse(value.expiresAt)<=now) return {...result,active:false};
  const s=value.state;
  requireValid(exact(s,stateKeys) && provider(s.provider) && target(s.chatID,s.provider) &&
    (s.slotIndex===null || integer(s.slotIndex,0,5)) && view(s.view) && (s.view==='home' || s.chatID!==null) &&
    integer(s.page,0,999) && typeof s.draft==='string' && Array.from(s.draft).length<=16000 &&
    typeof s.recording==='boolean' && ['none','queued','confirmed','uncertain','failed'].includes(s.sendState) &&
    integer(s.refreshNonce,0,Number.MAX_SAFE_INTEGER));
  Object.assign(result,{sourceID:value.sourceID,sourceName:value.sourceName,expiresAt:value.expiresAt,
    state:Object.fromEntries(stateKeys.map(key=>[key,s[key]]))});
  if (typeof value.chatTitle==='string') result.chatTitle=value.chatTitle.slice(0,240);
  const f=value.feedback;
  if (object(f) && f.revision===value.revision && integer(f.pageCount,1,1000) &&
    integer(f.renderedPage,0,f.pageCount-1) && typeof f.connected==='boolean')
    result.feedback={revision:f.revision,pageCount:f.pageCount,renderedPage:f.renderedPage,connected:f.connected};
  return result;
}
