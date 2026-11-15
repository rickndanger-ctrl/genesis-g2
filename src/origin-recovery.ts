import { normalizeBaseURL } from './api';
import type { StoragePort } from './storage';
import type { Gateway, Host } from './types';

export const ORIGIN_RECOVERY_KEY = 'genesis-g2.origin-recovery.v1';
const DAY = 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const secret = /^[A-Za-z0-9_-]{43}$/;
type Credential = { binding: string; installationID: string; secret: string };
type Saved = { version: 1; hosts: Record<string, Credential> };
type Flight = { promise: Promise<boolean>; controller: AbortController; users: number; settled: boolean };
type Attempt = { origin: string; renewedAt: number; nextTry: number; failures: number; needsEnrollment?: boolean };
export interface OriginRecoveryPort {
  beforeRequest(host: Host, signal: AbortSignal): Promise<boolean>;
  afterStatus(host: Host, signal: AbortSignal): Promise<void>;
  recover(host: Host, signal: AbortSignal): Promise<boolean>;
}
export type OriginRecoveryOptions = {
  nativeAvailable: () => boolean; origin: () => string; hosts: () => Host[];
  fetcher?: typeof fetch; now?: () => number; timeoutMs?: number;
};
const aborted = () => new DOMException('Request canceled', 'AbortError');
export function canonicalEvenOrigin(origin: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(origin);
  return Boolean(match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535);
}
function wait<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = () => { signal.removeEventListener('abort', cancel); if (timer) clearTimeout(timer); };
    const cancel = () => { end(); reject(aborted()); };
    signal.addEventListener('abort', cancel, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => { end(); reject(new Error('Native operation timed out.')); }, timeoutMs);
    promise.then(value => { end(); resolve(value); }, error => { end(); reject(error); });
  });
}
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function parse(raw: string): Saved {
  if (!raw) return { version: 1, hosts: {} };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid native recovery state.');
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || !value.hosts || typeof value.hosts !== 'object' || Array.isArray(value.hosts) || Object.keys(value.hosts).length > 12) throw new Error('Invalid native recovery state.');
  const hosts: Record<string, Credential> = {};
  for (const [key, rawEntry] of Object.entries(value.hosts)) {
    if (!digest.test(key) || !rawEntry || typeof rawEntry !== 'object') throw new Error('Invalid native recovery state.');
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.binding !== 'string' || !digest.test(entry.binding) || typeof entry.installationID !== 'string' || !uuid.test(entry.installationID) || typeof entry.secret !== 'string' || !secret.test(entry.secret)) throw new Error('Invalid native recovery state.');
    hosts[key] = { binding: entry.binding, installationID: entry.installationID, secret: entry.secret };
  }
  return { version: 1, hosts };
}

/** Recovery authority exists only after a native package-storage readback.
 * No browser storage, URLs, logs, or diagnostics ever receive these secrets. */
export class OriginRecovery implements OriginRecoveryPort {
  private bridge: StoragePort | null = null;
  private saved: Saved = { version: 1, hosts: {} };
  private binding: Promise<boolean> | null = null;
  private persistence: Promise<void> | null = null;
  private flights = new Map<string, Flight>();
  private attempts = new Map<string, Attempt>();
  private fetcher: typeof fetch;
  private now: () => number;
  private timeoutMs: number;
  constructor(private options: OriginRecoveryOptions) {
    this.fetcher = options.fetcher ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 4000;
  }
  async bindBridge(bridge: StoragePort): Promise<boolean> {
    if (!this.options.nativeAvailable()) return false;
    if (this.bridge === bridge) return true;
    if (this.binding) return this.binding;
    this.binding = (async () => {
      try {
        const saved = parse(await wait(bridge.getLocalStorage(ORIGIN_RECOVERY_KEY), new AbortController().signal, this.timeoutMs));
        if (!this.options.nativeAvailable()) return false;
        this.saved = saved; this.bridge = bridge; this.attempts.clear(); return true;
      } catch { return false; }
    })();
    try { return await this.binding; } finally { this.binding = null; }
  }
  private usable(host: Host): boolean {
    if (!this.bridge || !this.options.nativeAvailable() || !canonicalEvenOrigin(this.options.origin())) return false;
    try { return this.options.hosts().some(current => normalizeBaseURL(current.baseURL) === normalizeBaseURL(host.baseURL) && current.token === host.token && Boolean(host.token)); }
    catch { return false; }
  }
  private async identity(host: Host) {
    const baseURL = normalizeBaseURL(host.baseURL);
    return { baseURL, key: await hash(baseURL), binding: await hash(baseURL + '\0' + host.token) };
  }
  private async credential(host: Host, create: boolean, signal: AbortSignal): Promise<Credential | null> {
    const identity = await this.identity(host);
    if (signal.aborted || !this.usable(host)) return null;
    const found = this.saved.hosts[identity.key];
    if (found?.binding === identity.binding) return found;
    if (!create) return null;
    // A timed-out SDK write can still complete later. Keep its raw promise as
    // the lock; no later credential write may overtake an unknown durable result.
    if (this.persistence) {
      try { await wait(this.persistence, signal, this.timeoutMs); } catch { return null; }
      return this.credential(host, create, signal);
    }
    let result: Credential | null = null;
    const bridge = this.bridge!;
    const run = async () => {
      if (!this.usable(host) || bridge !== this.bridge) return;
      // Recover a write whose acknowledgment was lost before generating another
      // identity. Only this package key is read; browser storage is never used.
      const persisted = parse(await bridge.getLocalStorage(ORIGIN_RECOVERY_KEY));
      if (!this.usable(host) || bridge !== this.bridge) return;
      this.saved = persisted;
      const existing = persisted.hosts[identity.key];
      if (existing?.binding === identity.binding) { result = existing; return; }
      if (signal.aborted) return;
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const generated: Credential = { binding: identity.binding, installationID: crypto.randomUUID(), secret: btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
      const next: Saved = { version: 1, hosts: { ...persisted.hosts, [identity.key]: generated } };
      const allowed = new Map(await Promise.all(this.options.hosts().map(async paired => { const id = await this.identity(paired); return [id.key, id.binding] as const; })));
      for (const [key, value] of Object.entries(next.hosts)) if (allowed.get(key) !== value.binding) delete next.hosts[key];
      if (Object.keys(next.hosts).length > 12 || signal.aborted || !this.usable(host)) return;
      const encoded = JSON.stringify(next);
      try { await bridge.setLocalStorage(ORIGIN_RECOVERY_KEY, encoded); } catch { /* Read back a possibly completed write before deciding. */ }
      const readback = await bridge.getLocalStorage(ORIGIN_RECOVERY_KEY);
      if (readback !== encoded || !this.usable(host) || bridge !== this.bridge) return;
      this.saved = parse(readback); result = this.saved.hosts[identity.key] ?? null;
    };
    const writing = run().catch(() => {});
    this.persistence = writing;
    void writing.finally(() => { if (this.persistence === writing) this.persistence = null; });
    try { await wait(writing, signal, this.timeoutMs); } catch { return null; }
    return signal.aborted ? null : result;
  }

  private async shared(key: string, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    if (signal.aborted) throw aborted();
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, users: 0, settled: false, promise: Promise.resolve(false) };
      const current = flight;
      current.promise = operation(controller.signal).catch(() => false).finally(() => { current.settled = true; if (this.flights.get(key) === current) this.flights.delete(key); });
      this.flights.set(key, current);
    }
    flight.users++;
    try { return await wait(flight.promise, signal); }
    finally { flight.users--; if (!flight.users && !flight.settled) flight.controller.abort(); }
  }
  private async exchange(host: Host, operation: 'enroll' | 'renew', credential: Credential, signal: AbortSignal): Promise<boolean> {
    if (!this.usable(host) || signal.aborted) return false;
    const origin = this.options.origin(); const identity = await this.identity(host);
    if (signal.aborted || !this.usable(host) || this.options.origin() !== origin) return false;
    const key = identity.binding; const previous = this.attempts.get(key);
    const controller = new AbortController(); const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    let ok = false; let unsupported = false; let needsEnrollment = false;
    try {
      const request = this.fetcher(new URL(`/api/origin-recovery/${operation}`, identity.baseURL).toString(), {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${host.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationID: credential.installationID, secret: credential.secret }),
      });
      const response = await wait(request, controller.signal); unsupported = response.status === 404 || response.status === 501; needsEnrollment = operation === 'renew' && response.status === 401;
      const result: unknown = await wait(response.json(), controller.signal);
      if (response.ok && result && typeof result === 'object') {
        const value = result as Record<string, unknown>; const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
        ok = value.ok === true && value.version === 1 && expiresAt > this.now() && this.usable(host) && this.options.origin() === origin;
      }
    } catch { /* Keep normal pairing usable; all failure text stays content-free. */ }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
    if (!signal.aborted && this.usable(host)) {
      const failures = ok ? 0 : (previous?.failures ?? 0) + 1;
      this.attempts.set(key, { origin, renewedAt: ok ? this.now() : 0, nextTry: this.now() + (ok ? 30000 : unsupported ? 300000 : Math.min(300000, 30000 * 2 ** Math.min(4, failures - 1))), failures, needsEnrollment });
    }
    return ok;
  }
  private async run(host: Host, signal: AbortSignal, mode: 'before' | 'recover' | 'enroll'): Promise<boolean> {
    if (signal.aborted) throw aborted();
    if (!this.usable(host)) return false;
    let identity: Awaited<ReturnType<OriginRecovery['identity']>>;
    try { identity = await this.identity(host); }
    catch { if (signal.aborted) throw aborted(); return false; }
    if (signal.aborted) throw aborted();
    if (!this.usable(host)) return false;
    const key = identity.binding;
    return this.shared(key, signal, async sharedSignal => {
      const attempt = this.attempts.get(key); const now = this.now(); const origin = this.options.origin();
      if (attempt?.origin === origin) {
        if (mode !== 'recover' && attempt.renewedAt > 0 && now - attempt.renewedAt < DAY) return true;
        if (now < attempt.nextTry && !(mode === 'enroll' && attempt.needsEnrollment)) return false;
      }
      const credential = await this.credential(host, mode === 'enroll', sharedSignal);
      if (!credential) {
        if (mode === 'enroll' && !sharedSignal.aborted && this.usable(host)) this.attempts.set(key, { origin, renewedAt: 0, nextTry: now + 30000, failures: 1 });
        return false;
      }
      return this.exchange(host, mode === 'enroll' ? 'enroll' : 'renew', credential, sharedSignal);
    });
  }
  async warmPairedHosts(gateway: Pick<Gateway, 'status'>): Promise<void> {
    await Promise.all(this.options.hosts().map(async host => {
      if (!this.usable(host)) return;
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs * 3);
      try {
        await wait(gateway.status(host, controller.signal), controller.signal);
        await this.afterStatus(host, controller.signal);
      } catch { /* One offline Mac must not block the other paired computers. */ }
      finally { clearTimeout(timer); }
    }));
  }
  beforeRequest(host: Host, signal: AbortSignal) { return this.run(host, signal, 'before'); }
  recover(host: Host, signal: AbortSignal) { return this.run(host, signal, 'recover'); }
  async afterStatus(host: Host, signal: AbortSignal): Promise<void> { await this.run(host, signal, 'enroll'); }
}
