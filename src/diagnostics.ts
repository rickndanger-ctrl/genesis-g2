import type { Host } from './types';

export type DiagnosticEvent = 'boot' | 'bridge_ready' | 'bridge_timeout' | 'device_status' | 'device_timeout' | 'page_ack' | 'page_failed' | 'input' | 'input_rejected' | 'connected' | 'disconnected' | 'mac_status';
export type DiagnosticKey = 'native' | 'phase' | 'status' | 'connected' | 'ack' | 'source' | 'eventType' | 'index' | 'containerID' | 'expectedID' | 'reason' | 'sequence' | 'deviceConnected';
export type DiagnosticData = Partial<Record<DiagnosticKey, number>>;
export type DiagnosticRecord = { seq: number; at: number; event: DiagnosticEvent; data: DiagnosticData };
export type DiagnosticRecorder = (event: DiagnosticEvent, data?: DiagnosticData) => void;
const keys = new Set<DiagnosticKey>(['native', 'phase', 'status', 'connected', 'ack', 'source', 'eventType', 'index', 'containerID', 'expectedID', 'reason', 'sequence', 'deviceConnected']);

// Deliberately incapable of retaining strings from chats, credentials, device
// identifiers, URLs, or audio. The private bridge receives only these enums and
// bounded numeric fields, authenticated by the existing pairing.
export class ConnectionDiagnostics {
  readonly session: string;
  private records: DiagnosticRecord[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  private sent = new Map<string, number>();
  private uploading = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private host: () => Host | null, private fetcher: typeof fetch = (...args) => globalThis.fetch(...args), session = crypto.randomUUID()) { this.session = session; }
  readonly record: DiagnosticRecorder = (event, data = {}) => {
    const clean: DiagnosticData = {};
    for (const [key, value] of Object.entries(data)) if (keys.has(key as DiagnosticKey) && Number.isInteger(value) && value >= -1 && value <= 2147483647) clean[key as DiagnosticKey] = value;
    this.records.push({ seq: ++this.seq, at: Date.now(), event, data: clean });
    if (this.records.length > 128) this.records.shift();
    for (const listener of this.listeners) listener();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 350);
  };
  snapshot() { return { session: this.session, events: this.records.map(row => ({ ...row, data: { ...row.data } })) }; }
  subscribe(listener: () => void) { this.listeners.add(listener); listener(); return () => this.listeners.delete(listener); }
  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.listeners.clear(); }
  async flush(): Promise<void> {
    const host = this.host();
    if (!host?.token || !host.baseURL || this.uploading) return;
    const after = this.sent.get(host.baseURL) ?? 0;
    const events = this.records.filter(row => row.seq > after).slice(0, 32);
    if (!events.length) return;
    this.uploading = true;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4000);
    let succeeded = false;
    try {
      const response = await this.fetcher(new URL('/api/diagnostics', host.baseURL).toString(), { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal, headers: { Authorization: `Bearer ${host.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session: this.session, events }) });
      if (response.ok) { this.sent.set(host.baseURL, events.at(-1)!.seq); succeeded = true; }
    } catch { /* local diagnostics remain available when the Mac is unreachable */ }
    finally { clearTimeout(timer); this.uploading = false; }
    if (succeeded && this.records.some(row => row.seq > (this.sent.get(host.baseURL) ?? 0))) await this.flush();
  }
}
