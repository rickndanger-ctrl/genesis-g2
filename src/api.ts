import type { OriginRecoveryPort } from './origin-recovery';
import type { Chat, ConversationTurn, DisplayState, FollowFeedback, FollowSnapshot, Gateway, Host, HostStatus, OpenResult, Provider, Reply, Slot } from './types';

export class GatewayError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function normalizeBaseURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter the HTTPS address from your Genesis bridge.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Use an HTTPS origin without a path, password, or query. HTTP is only available on localhost.');
  }
  return url.origin;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError('invalid_response', 'The bridge returned an invalid response.');
  return value as Record<string, unknown>;
};
const string = (value: unknown, max = 200000): string => {
  if (typeof value !== 'string' || value.length > max) throw new GatewayError('invalid_response', 'The bridge response could not be read.');
  return value;
};
const boolean = (value: unknown): boolean => value === true;
const providerValue = (value: unknown): Provider => {
  if (value !== 'codex' && value !== 'claude') throw new GatewayError('invalid_response', 'Unknown agent in bridge response.');
  return value;
};
const chatValue = (raw: unknown): Chat => { const c = object(raw); return { id: string(c.id, 500), title: string(c.title, 2000) }; };
const array = (value: unknown, limit: number): unknown[] => {
  if (!Array.isArray(value) || value.length > limit) throw new GatewayError('invalid_response', 'The bridge returned an invalid list.');
  return value;
};
const integer = (value: unknown, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new GatewayError('invalid_response', 'The native controller returned invalid display state.');
  return value;
};
export function conversationValue(value: unknown): ConversationTurn[] {
  let total = 0;
  return array(value, 6).map(raw => {
    const turn = object(raw);
    if (turn.role !== 'user' && turn.role !== 'assistant') throw new GatewayError('invalid_response', 'The bridge returned an unsupported conversation role.');
    const text = string(turn.text, 32000); total += Array.from(text).length;
    if (total > 16000) throw new GatewayError('invalid_response', 'The conversation excerpt is too large.');
    const phase = turn.role === 'assistant' && typeof turn.phase === 'string' && ['final_answer', 'partial_answer', 'commentary', 'unknown'].includes(turn.phase) ? turn.phase as ConversationTurn['phase'] : undefined;
    return { role: turn.role, text, ...(phase ? { phase } : {}), ...(turn.truncated === true ? { truncated: true } : {}) };
  });
}
export function followValue(raw: unknown): FollowSnapshot {
  const d = object(raw);
  if (d.version !== 1 || typeof d.active !== 'boolean') throw new GatewayError('invalid_response', 'This display session is not supported.');
  for (const key of ['supportsKeepReading', 'keepReading', 'readingOnly']) {
    if (Object.hasOwn(d, key) && typeof d[key] !== 'boolean') throw new GatewayError('invalid_response', 'The native controller returned invalid reading state.');
  }
  const base = { version: 1 as const, hostID: string(d.hostID, 500), revision: integer(d.revision, Number.MAX_SAFE_INTEGER), ...(typeof d.supportsKeepReading === 'boolean' ? { supportsKeepReading: d.supportsKeepReading } : {}) };
  if (!d.active) return { ...base, active: false, ...(typeof d.supported === 'boolean' ? { supported: d.supported } : {}) };
  const s = object(d.state); const expiresAt = string(d.expiresAt, 100); const draft = string(s.draft, 32000);
  if (!['iPhone', 'iPad'].includes(String(d.sourceName)) || !Number.isFinite(Date.parse(expiresAt)) ||
    !['home', 'reply', 'draft'].includes(String(s.view)) || !['none', 'queued', 'confirmed', 'uncertain', 'failed'].includes(String(s.sendState)) ||
    typeof s.recording !== 'boolean' || Array.from(draft).length > 16000) throw new GatewayError('invalid_response', 'The native controller returned invalid display state.');
  const chatID = s.chatID == null ? null : string(s.chatID, 500);
  if (s.view !== 'home' && !chatID) throw new GatewayError('invalid_response', 'The display session has no selected chat.');
  if ((d.keepReading === true && d.supportsKeepReading === false) || (d.readingOnly === true &&
    (d.keepReading !== true || !chatID || s.view !== 'reply' || s.page !== 0 || draft !== '' || s.recording !== false || s.sendState !== 'none'))) {
    throw new GatewayError('invalid_response', 'The native controller returned invalid reading state.');
  }
  let feedback: Extract<FollowSnapshot, { active: true }>['feedback'];
  if (d.feedback != null) {
    const f = object(d.feedback); const pageCount = integer(f.pageCount, 1000); const renderedPage = integer(f.renderedPage, 999);
    if (f.revision !== base.revision || typeof f.connected !== 'boolean' || pageCount < 1 || renderedPage >= pageCount) throw new GatewayError('invalid_response', 'The display acknowledgment is invalid.');
    feedback = { revision: base.revision, pageCount, renderedPage, connected: f.connected };
  }
  return { ...base, active: true, sourceID: string(d.sourceID, 500), sourceName: d.sourceName as 'iPhone' | 'iPad', expiresAt,
    ...(typeof d.keepReading === 'boolean' ? { keepReading: d.keepReading } : {}),
    ...(typeof d.readingOnly === 'boolean' ? { readingOnly: d.readingOnly } : {}),
    ...(typeof d.chatTitle === 'string' ? { chatTitle: string(d.chatTitle, 2000) } : {}),
    ...(feedback ? { feedback } : {}),
    state: { provider: providerValue(s.provider), chatID, slotIndex: s.slotIndex == null ? null : integer(s.slotIndex, 5), view: s.view as DisplayState['view'], page: integer(s.page, 999), draft, recording: s.recording, sendState: s.sendState as DisplayState['sendState'], refreshNonce: integer(s.refreshNonce, Number.MAX_SAFE_INTEGER) } };
}

export class HTTPGateway implements Gateway {
  // Native WebView fetch requires the global receiver. Storing the unbound
  // function and calling this.fetcher() binds it to this Gateway instead.
  constructor(private fetcher: typeof fetch = (...args) => globalThis.fetch(...args), private recovery?: OriginRecoveryPort) {}
  setOriginRecovery(recovery: OriginRecoveryPort) { this.recovery = recovery; }
  private async request(host: Host, path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new DOMException('Request canceled', 'AbortError');
    await this.recovery?.beforeRequest(host, signal);
    try { return await this.requestOnce(host, path, signal, body); }
    catch (error) {
      // Only reads may be retried. A lost POST response can mean its action ran.
      if (body === undefined && !signal.aborted && error instanceof GatewayError && ['unreachable', 'origin_denied'].includes(error.code) && await this.recovery?.recover(host, signal)) return this.requestOnce(host, path, signal);
      throw error;
    }
  }
  private async requestOnce(host: Host, path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
    if (!host.token) throw new GatewayError('unpaired', 'Pair this computer to load its chats.');
    if (signal.aborted) throw new DOMException('Request canceled', 'AbortError');
    const url = new URL(path, normalizeBaseURL(host.baseURL));
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 12000);
    try {
      const response = await this.fetcher(url.toString(), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: timeout.signal,
        headers: { Authorization: `Bearer ${host.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = object(await response.json());
      if (!response.ok) {
        const error = result.error && typeof result.error === 'object' ? object(result.error) : {};
        // Only the bridge's intentionally public message is surfaced; never URL, headers, or response bodies.
        throw new GatewayError(typeof error.code === 'string' ? error.code : 'request_failed', typeof error.message === 'string' ? error.message.slice(0, 300) : 'The computer could not complete that request.');
      }
      return result;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (signal.aborted) throw new DOMException('Request canceled', 'AbortError');
      throw new GatewayError('unreachable', 'Could not reach this computer. Check its Genesis bridge and Tailscale connection, then refresh.');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  async status(host: Host, signal: AbortSignal): Promise<HostStatus> {
    const d = await this.request(host, '/api/status', signal); const h = object(d.host);
    const status = { host: { id: string(h.id, 500), name: string(h.name, 200) }, version: string(d.version, 100), providers: array(d.providers, 2).map(raw => {
      const p = object(raw); return { id: providerValue(p.id), label: string(p.label, 100), available: boolean(p.available), canReadReply: boolean(p.canReadReply), ...(typeof p.reason === 'string' ? { reason: p.reason.slice(0, 300) } : {}) };
    }) };
    // An authenticated, normally allowed status response permits enrollment.
    // Display updates need not wait for native credential storage/network work.
    if (this.recovery) {
      // Probe/route completion aborts its own signal. Enrollment is independent
      // connection maintenance, still constrained to currently paired credentials.
      const maintenance = new AbortController(); const timer = setTimeout(() => maintenance.abort(), 12000);
      void this.recovery.afterStatus(host, maintenance.signal).catch(() => {}).finally(() => clearTimeout(timer));
    }
    return status;
  }
  async profile(host: Host, provider: Provider, signal: AbortSignal): Promise<{ provider: Provider; slots: Slot[] }> {
    const d = await this.request(host, `/api/profile?provider=${provider}`, signal);
    const seen = new Set<number>();
    const slots = array(d.slots, 6).map(raw => {
      const s = object(raw); const slot = Number(s.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > 6 || seen.has(slot) || !['empty', 'chat', 'shortcut'].includes(String(s.kind))) throw new GatewayError('invalid_response', 'The bridge returned invalid chat slots.');
      seen.add(slot);
      return { slot, label: string(s.label, 2000), chatID: s.chatID == null ? null : string(s.chatID, 500), kind: s.kind as Slot['kind'], ...(typeof s.action === 'string' ? { action: s.action } : {}) };
    });
    return { provider: providerValue(d.provider), slots };
  }
  async chats(host: Host, provider: Provider, signal: AbortSignal): Promise<{ provider: Provider; chats: Chat[] }> {
    const d = await this.request(host, `/api/chats?provider=${provider}`, signal);
    return { provider: providerValue(d.provider), chats: array(d.chats, 5000).map(chatValue) };
  }
  async open(host: Host, provider: Provider, chat: Chat, slot: number | undefined, signal: AbortSignal): Promise<OpenResult> {
    const d = await this.request(host, '/api/open', signal, { provider, chatID: chat.id, ...(slot === undefined ? {} : { slot }) });
    if (d.ok !== true || !['requested', 'confirmed'].includes(String(d.status))) throw new GatewayError('invalid_response', 'The computer did not confirm the open request.');
    return { ok: true, chat: chatValue(d.chat), status: d.status as OpenResult['status'] };
  }
  async reply(host: Host, provider: Provider, chatID: string, signal: AbortSignal): Promise<Reply> {
    const d = await this.request(host, `/api/reply?provider=${provider}&chatID=${encodeURIComponent(chatID)}`, signal);
    return { provider: providerValue(d.provider), chatID: string(d.chatID, 500), title: string(d.title, 2000), text: string(d.text), revision: string(d.revision, 200), updatedAt: d.updatedAt == null ? null : string(d.updatedAt, 200), status: ['working', 'done', 'idle'].includes(String(d.status)) ? d.status as Reply['status'] : 'unknown', truncated: boolean(d.truncated), phase: ['final_answer', 'partial_answer', 'commentary'].includes(String(d.phase)) ? d.phase as Reply['phase'] : 'unknown', ...(d.turns === undefined ? {} : { turns: conversationValue(d.turns), turnsTruncated: d.turnsTruncated === true }) };
  }
  async follow(host: Host, signal: AbortSignal): Promise<FollowSnapshot> {
    return followValue(await this.request(host, '/api/follow', signal));
  }
  async followFeedback(host: Host, feedback: FollowFeedback, signal: AbortSignal): Promise<FollowSnapshot> {
    return followValue(await this.request(host, '/api/follow-feedback', signal, feedback));
  }
}
