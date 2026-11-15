import './style.css';
import { HTTPGateway } from './api';
import { ControllerStore } from './store';
import { GlassesController, glassesFrame, bounded, nativeTransportAvailable } from './glasses';
import { ConnectionDiagnostics } from './diagnostics';
import { HostStorage, validatedHost } from './storage';
import { startup } from './startup';
import { providerName, slotName, SLOT_COLORS, type Host } from './types';
import { replyPages } from './pagination';
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';

const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const icons = {
  glasses: '<svg viewBox="0 0 48 24" fill="none" aria-hidden="true"><path d="M2 6h16c2 0 3 2 3 4v3c0 5-3 8-8 8S4 19 3 14L1 3m46 3H30c-2 0-3 2-3 4v3c0 5 3 8 8 8s9-2 10-7l2-11M21 11c2-2 4-2 6 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="9" cy="6" r="2.5"/><circle cx="16" cy="12" r="2.5"/><circle cx="7" cy="18" r="2.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 10a8 8 0 1 0-1 7M20 3v7h-7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 5 7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// bootstrap removed the pairing fragment before this module and the SDK loaded.
const incoming = startup.incoming;
let bootError = startup.error;
startup.incoming = null;
startup.error = null;
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<main class="shell">
  <header class="brand"><div><div class="eyebrow">G E N E S I S</div><h1>Your agents.<br><span>Within a glance.</span></h1></div><button class="icon-button" id="settings-open" aria-label="Pair computers and settings">${icons.settings}</button></header>
  <section class="route-card" aria-label="Computer and agent"><div class="section-label">CONNECTED WORKSPACE <span class="version">G2 / 01</span></div><nav class="host-switch" id="hosts" aria-label="Computers"></nav><nav class="provider-switch" id="providers" aria-label="Agent"><button data-provider="codex"><span class="provider-icon">⌘</span> Codex</button><button data-provider="claude"><span class="provider-icon">✳</span> Claude</button></nav><div class="connection-row"><span id="connection"></span><button id="refresh" class="icon-button small" aria-label="Refresh computer and chats">${icons.refresh}</button></div><div class="top-glasses"><div><strong>Glasses</strong><span id="glasses-status-top">Not connected yet</span></div><button id="glasses-connect-top" class="primary">Connect glasses</button></div></section>
  <div id="preview-banner" class="preview-banner" hidden><span>DEMO · Sample chats, no computer connected</span><button id="leave-demo">Exit preview</button></div>
  <div id="notice" class="notice" role="alert" hidden></div>
  <section id="onboarding" class="onboarding" hidden><div class="optical-mark">${icons.glasses}</div><h2>A little closer to your work.</h2><p>Pair a Genesis bridge to bring your chats into view. Your existing controller keeps its own settings.</p><div class="button-row"><button class="primary" id="pair-start">Pair a computer</button><button class="quiet" id="demo-start">Explore preview</button></div></section>
  <section class="controller" aria-label="Six chat slots"><div class="screw top-left"></div><div class="screw top-right"></div><div class="screw bottom-left"></div><div class="screw bottom-right"></div><div class="controller-top"><span class="wordmark">GENESIS <b>G2</b></span><span id="controller-agent" class="micro-label">CODEX</span></div><div class="slot-grid" id="slots"></div><div class="controller-bottom"><span class="dots" aria-hidden="true">⠿</span><span>ONE GLANCE. SIX CONVERSATIONS.</span><span class="small-glasses">${icons.glasses}</span></div></section>
  <section class="reader" aria-label="Latest assistant response"><div class="reader-top"><span class="section-label" id="reader-label">LATEST RESPONSE</span><span id="reply-state" class="pill">Choose a chat</span></div><h2 id="chat-title">Room for your next idea.</h2><p id="reader-empty">Select a chat above to open it on your computer and read its latest reply here.</p><div id="reply-text" class="reply-text" hidden></div><div id="reply-meta" class="reply-meta"></div><div id="reader-controls" class="reader-controls" hidden><button id="page-prev" class="page-button" aria-label="Previous reply page">←</button><span id="page-indicator"></span><button id="page-next" class="page-button" aria-label="Next reply page">→</button><button id="back-to-chats" class="quiet">Back to chats</button></div></section>
  <section class="hud-card" aria-label="Glasses display preview"><div class="section-heading"><div><div class="section-label">IN YOUR LINE OF SIGHT</div><h2>Glasses view</h2></div><span class="small-glasses">${icons.glasses}</span></div><div class="hud" id="hud"></div><div class="hud-controls"><button data-gesture="up" aria-label="Preview swipe up">↑</button><button data-gesture="select">Tap</button><button data-gesture="down" aria-label="Preview swipe down">↓</button><button data-gesture="back">Back</button><button id="glasses-menu">Menu</button></div><div id="hud-menu" class="hud-menu" hidden><button data-view="slots">Chats</button><button data-view="hosts">Computers</button><button data-view="providers">Agents</button><button id="hud-refresh">Refresh</button></div><p class="hint">Swipe to move · Tap to open or page forward · Double-tap to go back</p><div class="glasses-connection"><span id="glasses-status">Phone preview · Glasses not connected</span><button id="glasses-connect" class="quiet">Connect glasses</button></div></section>
  <details class="connection-details"><summary>Connection details</summary><p class="hint">Technical connection events only. No messages, speech, names, or pairing tokens.</p><pre id="diagnostic-events"></pre><button id="copy-diagnostics" class="quiet">Copy connection details</button><span id="diagnostic-copy-result" role="status"></span></details>
  <section class="chat-library"><div class="section-heading"><h2>All chats</h2><span id="chat-count" class="pill">0</span></div><label class="search"><span aria-hidden="true">⌕</span><input id="chat-search" type="search" placeholder="Find a conversation" autocomplete="off" /></label><div id="chat-list"></div></section>
  <footer class="footnote"><span>Genesis G2 · Reader preview</span><p>Open chats and read replies. Voice, Send, and artifact controls are not part of this version.</p></footer>
</main>
<dialog id="settings"><form id="pair-form"><div class="dialog-top"><div class="eyebrow">GENESIS G2</div><button type="button" id="settings-close" class="icon-button" aria-label="Close settings">×</button></div><h2>Pair your workspace.</h2><p class="muted">Use the connection details from your Genesis G2 bridge. Each computer has its own private pairing token.</p><label>Computer name<input name="name" placeholder="Mini 2" maxlength="80" required autocomplete="off" /></label><label>Bridge address<input name="baseURL" type="url" placeholder="https://your-computer.example.ts.net" required autocomplete="off" autocapitalize="none" spellcheck="false" /></label><label>Pairing token<input name="token" type="password" placeholder="Paste the private token" required autocomplete="off" autocapitalize="none" spellcheck="false" /></label><p id="pair-error" class="form-error" role="alert"></p><button class="primary" type="submit">Save and connect</button><div class="saved-hosts"><h3>Paired computers</h3><div id="saved-hosts"></div></div><p class="hint">Pairing stays on this device. Nothing is added to Home or bundled into the app download.</p></form></dialog>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const settings = $<HTMLDialogElement>('settings');
const nativeHost = nativeTransportAvailable();
let bridgeStorage;
if (nativeHost) { try { bridgeStorage = await bounded(waitForEvenAppBridge(), 3000); } catch { /* phone preview still works */ } }
const local = { getItem: (key: string) => { try { return localStorage.getItem(key); } catch { return null; } }, setItem: (key: string, value: string) => { localStorage.setItem(key, value); } };
const storage = new HostStorage(local, bridgeStorage);
const hosts: Host[] = await bounded(storage.load(), 3500).catch((): Host[] => []);
if (incoming) {
  const existing = hosts.findIndex(h => h.id === incoming!.id);
  if (existing >= 0) hosts[existing] = incoming; else hosts.push(incoming);
  try { await bounded(storage.save(hosts), 3500); } catch { bootError = 'Connected for this visit, but pairing could not be saved. Check storage access before closing the app.'; }
}
const store = new ControllerStore(new HTTPGateway(), hosts);
if (incoming) store.state.hostID = incoming.id;
const diagnostics = new ConnectionDiagnostics(() => store.state.demo ? null : store.host);
diagnostics.record('boot', { native: nativeHost ? 1 : 0, phase: 1 });
diagnostics.subscribe(() => { $('diagnostic-events').textContent = diagnostics.snapshot().events.slice(-12).map(event => `${event.seq} ${event.event} ${JSON.stringify(event.data)}`).join('\n'); });
const glasses = new GlassesController(store, (status, connected) => {
  for (const id of ['glasses-status', 'glasses-status-top']) { $(id).textContent = status; $(id).classList.toggle('is-connected', connected); }
  for (const id of ['glasses-connect', 'glasses-connect-top']) $(id).textContent = connected ? 'Reconnect glasses' : 'Connect glasses';
}, undefined, diagnostics.record);
let search = '';
let lastMacStatus = '';
const openSettings = () => { renderSavedHosts(); settings.showModal(); };
function renderSavedHosts() {
  $('saved-hosts').innerHTML = store.state.hosts.length ? store.state.hosts.map((h, i) => `<div class="saved-host"><span>${esc(h.name)}<small>${esc(new URL(h.baseURL).hostname)}</small></span><button type="button" data-forget="${i}" class="quiet">Forget</button></div>`).join('') : '<p class="muted">No computers paired yet.</p>';
}
function renderChats() {
  const filtered = store.state.chats.filter(c => c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  $('chat-count').textContent = String(store.state.chats.length);
  $('chat-list').innerHTML = filtered.length ? filtered.slice(0, 150).map(c => `<button class="chat-row ${store.state.selected?.id === c.id ? 'selected' : ''}" data-chat="${esc(c.id)}"><span>${esc(c.title || 'Untitled chat')}</span>${icons.arrow}</button>`).join('') : `<p class="empty-list">${search ? 'No chats match that search.' : 'Your available chats appear here after connecting.'}</p>`;
}
store.subscribe(state => {
  const host = store.host;
  $('hosts').innerHTML = state.hosts.map(h => `<button data-host="${esc(h.id)}" class="${!state.demo && h.id === state.hostID ? 'active' : ''}"><span aria-hidden="true">▱</span>${esc(h.name)}</button>`).join('') + `<button id="host-add" class="${state.hosts.length ? 'add-host' : ''}" aria-label="Pair a computer">${state.hosts.length ? '+' : '+ Pair a computer'}</button>`;
  document.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => { const selected = button.dataset.provider === state.provider; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
  $('connection').innerHTML = `<i class="status-dot ${state.demo ? 'demo' : state.connected ? 'online' : ''}"></i>${state.demo ? 'Demo · No Mac connected' : state.busy && !state.connected ? 'Mac · Connecting…' : state.connected ? `Mac connected · ${esc(host?.name ?? '')}` : host ? `Mac offline · ${esc(host.name)}` : 'Mac · Not paired'}`;
  const macStatus = `${state.demo}:${state.connected}:${state.busy}:${state.provider}`;
  if (macStatus !== lastMacStatus) { lastMacStatus = macStatus; diagnostics.record('mac_status', { connected: state.connected ? 1 : 0, phase: state.busy ? 1 : 0, source: state.provider === 'codex' ? 1 : 2, status: state.demo ? 1 : 0 }); }
  $<HTMLButtonElement>('refresh').disabled = !host || state.busy;
  $('preview-banner').hidden = !state.demo;
  $('onboarding').hidden = Boolean(host);
  const error = state.error ?? bootError;
  $('notice').hidden = !error;
  $('notice').textContent = error ?? '';
  $('controller-agent').textContent = providerName(state.provider).toUpperCase();
  $('slots').innerHTML = state.slots.map(s => `<button class="slot ${state.selectedSlot === s.slot ? 'selected' : ''} ${s.kind !== 'chat' ? 'unassigned' : ''}" data-slot="${s.slot}" style="--slot-color:${SLOT_COLORS[s.slot - 1]}" aria-label="${esc(slotName(state.provider, s.slot) + ': ' + s.label)}" ${!state.connected ? 'disabled' : ''}><div class="slot-top"><span class="slot-dot"></span><b>${slotName(state.provider, s.slot)}</b><span class="slot-corner">${s.kind === 'shortcut' ? '↗' : '⌁'}</span></div><span class="slot-title">${esc(s.label)}</span><span class="slot-bottom">${s.kind === 'shortcut' ? 'Shortcut · unavailable here' : s.kind === 'chat' ? 'Open conversation' : 'No chat assigned'}</span></button>`).join('');
  const pages = replyPages(state.reply?.text ?? ''); const page = Math.min(state.page, pages.length - 1);
  $('reader-label').textContent = state.demo ? 'SAMPLE RESPONSE' : 'LATEST RESPONSE';
  $('chat-title').textContent = state.selected?.title ?? 'Room for your next idea.';
  $('reply-state').textContent = state.busy ? 'Loading…' : state.reply?.phase === 'commentary' ? 'Progress update' : state.reply?.phase === 'partial_answer' ? 'Partial reply' : state.reply?.status === 'working' ? 'Working' : state.reply?.status === 'done' && state.reply?.phase === 'final_answer' ? 'Completed reply' : state.reply ? 'Latest reply' : state.selected ? 'No reply yet' : 'Choose a chat';
  $('reader-empty').hidden = Boolean(state.selected);
  $('reply-text').hidden = !state.selected;
  $('reply-text').textContent = state.reply ? pages[page] : state.busy ? 'Opening your conversation…' : 'No assistant reply is available yet. Refresh to check again.';
  $('reply-meta').textContent = state.selected ? [state.demo ? 'Sample content only' : state.openStatus === 'requested' ? 'Open requested on computer' : state.openStatus === 'confirmed' ? 'Chat opened on computer' : '', state.reply?.truncated ? 'Reply excerpt · Open the computer for the full response' : ''].filter(Boolean).join(' · ') : '';
  $('reader-controls').hidden = !state.selected;
  $('page-indicator').textContent = `${page + 1} / ${pages.length}`;
  $<HTMLButtonElement>('page-prev').disabled = page === 0;
  $<HTMLButtonElement>('page-next').disabled = page >= pages.length - 1;
  const frame = glassesFrame(state, host?.name ?? 'Pair a computer');
  $('hud').innerHTML = `<div class="hud-title">${esc(frame.title)}</div>${frame.kind === 'list' ? `<ol>${frame.items.map((item, i) => `<li class="${state.focus === i ? 'focused' : ''}">${esc(item)}</li>`).join('')}</ol>` : `<pre>${esc(frame.content)}</pre>`}<div class="hud-footer">${esc(frame.footer)}</div>`;
  renderChats(); glasses.render(state);
});

$('settings-open').onclick = openSettings;
$('settings-close').onclick = () => settings.close();
$('pair-start').onclick = openSettings;
$('demo-start').onclick = () => { bootError = null; void store.setDemo(true); };
$('leave-demo').onclick = () => void store.setDemo(false);
$('refresh').onclick = () => { bootError = null; void store.refresh(); };
$('back-to-chats').onclick = () => store.back();
$('page-prev').onclick = () => store.turnPage(-1, replyPages(store.state.reply?.text ?? '').length);
$('page-next').onclick = () => store.turnPage(1, replyPages(store.state.reply?.text ?? '').length);
$('glasses-connect').onclick = () => void glasses.connect();
$('glasses-connect-top').onclick = () => void glasses.connect();
$('copy-diagnostics').onclick = async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(diagnostics.snapshot(), null, 2)); $('diagnostic-copy-result').textContent = 'Copied'; }
  catch { $('diagnostic-copy-result').textContent = 'Copy is unavailable here. The details are shown above.'; }
};
$('glasses-menu').onclick = () => { $('hud-menu').hidden = !$('hud-menu').hidden; };
$('hud-refresh').onclick = () => void store.refresh();
$<HTMLInputElement>('chat-search').oninput = event => { search = (event.target as HTMLInputElement).value; renderChats(); };
app.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button || button.disabled) return;
  if (button.id === 'host-add') openSettings();
  if (button.dataset.host) void store.setHost(button.dataset.host);
  if (button.dataset.provider === 'codex' || button.dataset.provider === 'claude') void store.setProvider(button.dataset.provider);
  if (button.dataset.slot) void store.openSlot(Number(button.dataset.slot));
  if (button.dataset.chat) { const chat = store.state.chats.find(c => c.id === button.dataset.chat); if (chat) void store.openChat(chat); }
  if (button.dataset.view === 'slots' || button.dataset.view === 'hosts' || button.dataset.view === 'providers') { store.navigate(button.dataset.view); $('hud-menu').hidden = true; }
  if (button.dataset.gesture) {
    const type = { up: 1, down: 2, select: 0, back: 3 }[button.dataset.gesture];
    if (type !== undefined) glasses.handle({ textEvent: { eventType: type } } as Parameters<typeof glasses.handle>[0], true);
  }
});
$<HTMLFormElement>('pair-form').onsubmit = async event => {
  event.preventDefault();
  const form = event.target as HTMLFormElement; const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submit.disabled = true; $('pair-error').textContent = '';
  try {
    const data = new FormData(form); const host = validatedHost({ name: data.get('name'), baseURL: data.get('baseURL'), token: data.get('token') });
    const next = [...store.state.hosts.filter(h => h.id !== host.id), host];
    await bounded(storage.save(next), 4000);
    form.reset(); settings.close(); bootError = null; await store.setHosts(next, host.id);
  } catch (error) { $('pair-error').textContent = error instanceof Error ? error.message : 'Pairing could not be saved. Try again.'; }
  finally { submit.disabled = false; }
};
$('saved-hosts').onclick = async event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-forget]'); if (!button) return;
  const index = Number(button.dataset.forget); const host = store.state.hosts[index]; if (!host) return;
  const next = store.state.hosts.filter(h => h.id !== host.id);
  try { await bounded(storage.save(next), 4000); await store.setHosts(next); renderSavedHosts(); } catch { $('pair-error').textContent = 'Could not remove the saved pairing. Try again.'; }
};

// Poll only the current read route. No prompt or mic action can be sent by polling.
setInterval(() => { if (!document.hidden && store.state.view === 'reader' && store.state.openStatus && !store.state.busy) void store.refreshReply(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void store.refresh(); });
if (hosts.length) void store.refresh();
let automaticConnectStarted = false;
const connectWhenNativeReady = () => {
  if (!automaticConnectStarted && nativeTransportAvailable()) { automaticConnectStarted = true; void glasses.connect(); }
};
window.addEventListener('flutterInAppWebViewPlatformReady', connectWhenNativeReady);
window.addEventListener('evenAppBridgeReady', connectWhenNativeReady);
// Some host versions inject callHandler after the page's first module has run.
// These are bounded startup checks, not a continuing reconnect loop.
for (const delay of [0, 300, 1000, 3000]) setTimeout(connectWhenNativeReady, delay);
