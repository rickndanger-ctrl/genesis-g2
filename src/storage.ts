import { normalizeBaseURL } from './api';
import type { Host } from './types';

const KEY = 'genesis-g2.hosts.v1';
export type StoragePort = { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<boolean> };
export function validatedHost(raw: unknown): Host {
  if (!raw || typeof raw !== 'object') throw new Error('The pairing information is incomplete.');
  const h = raw as Record<string, unknown>;
  if (typeof h.name !== 'string' || !h.name.trim() || h.name.length > 80 || typeof h.baseURL !== 'string' || typeof h.token !== 'string' || !h.token.trim() || h.token.length > 2048 || /[\r\n]/.test(h.token)) throw new Error('The pairing information is incomplete.');
  const baseURL = normalizeBaseURL(h.baseURL);
  return { id: baseURL, name: h.name.trim(), baseURL, token: h.token.trim() };
}
export function parsePairingFragment(fragment: string): Host | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const encoded = params.get('pair');
  if (!encoded) return null;
  if (encoded.length > 10000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) throw new Error('This pairing link is invalid. Create a new link from your Genesis bridge.');
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value.v !== 1) throw new Error();
    return validatedHost(value);
  } catch { throw new Error('This pairing link is invalid. Create a new link from your Genesis bridge.'); }
}
export class HostStorage {
  private revision = 0;
  private writes: Promise<void> = Promise.resolve();
  private binding: Promise<Host[]> | null = null;
  private bound: StoragePort | null = null;
  constructor(private local: Pick<Storage, 'getItem' | 'setItem'>, private bridge?: StoragePort) {}
  async load(): Promise<Host[]> {
    // Native package storage is preferred inside Even; never share Home's storage keys.
    let saved: string | null = null;
    if (this.bridge) { try { saved = await this.bridge.getLocalStorage(KEY); } catch { /* local fallback */ } }
    if (!saved) { try { saved = this.local.getItem(KEY); } catch { /* disabled storage */ } }
    return this.parse(saved);
  }
  private parse(saved: string | null): Host[] {
    if (!saved) return [];
    try {
      const data: unknown = JSON.parse(saved);
      if (!Array.isArray(data)) return [];
      const hosts: Host[] = [];
      for (const raw of data.slice(0, 12)) { try { const h = validatedHost(raw); if (!hosts.some(existing => existing.id === h.id)) hosts.push(h); } catch { /* skip corrupt host only */ } }
      return hosts;
    } catch { return []; }
  }
  async bindBridge(bridge: StoragePort, currentHosts: () => Host[]): Promise<Host[]> {
    if (this.bound === bridge) return currentHosts();
    if (this.binding) return this.binding;
    const run = async () => {
      const revision = this.revision;
      // Read this package's key before migrating. Never inspect Home or another
      // package, and never replace current QR pairings with older stored tokens.
      const saved = this.parse(await bridge.getLocalStorage(KEY));
      const current = currentHosts().map(validatedHost);
      const merged = revision === this.revision ? [...saved.filter(h => !current.some(c => c.id === h.id)), ...current] : current;
      this.bridge = bridge;
      const writing = this.save(merged, true); const writeRevision = this.revision;
      await writing;
      this.bound = bridge;
      // A user may add or forget a computer while native storage is responding.
      // A newer save wins and must not be overwritten by this binding result.
      return writeRevision === this.revision ? merged : currentHosts();
    };
    this.binding = run();
    try { return await this.binding; } finally { this.binding = null; }
  }
  async save(hosts: Host[], requireNative = false): Promise<void> {
    const data = JSON.stringify(hosts.map(validatedHost));
    const bridge = this.bridge; this.revision++;
    const run = async () => {
      let persisted = false;
      let nativeSaved = false;
      try { this.local.setItem(KEY, data); persisted = true; } catch { /* native may still work */ }
      if (bridge) { try { if (await bridge.setLocalStorage(KEY, data)) { persisted = true; nativeSaved = true; } } catch { /* local fallback */ } }
      if (requireNative && !nativeSaved) throw new Error('Native pairing storage did not respond. Reconnect to retry.');
      if (!persisted) throw new Error('Pairing could not be saved on this device.');
    };
    this.writes = this.writes.then(run, run); await this.writes;
  }
}
