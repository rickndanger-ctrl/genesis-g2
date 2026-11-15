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
  constructor(private local: Pick<Storage, 'getItem' | 'setItem'>, private bridge?: StoragePort) {}
  async load(): Promise<Host[]> {
    // Native package storage is preferred inside Even; never share Home's storage keys.
    let saved: string | null = null;
    if (this.bridge) { try { saved = await this.bridge.getLocalStorage(KEY); } catch { /* local fallback */ } }
    if (!saved) { try { saved = this.local.getItem(KEY); } catch { /* disabled storage */ } }
    if (!saved) return [];
    try {
      const data: unknown = JSON.parse(saved);
      if (!Array.isArray(data)) return [];
      const hosts: Host[] = [];
      for (const raw of data.slice(0, 12)) { try { const h = validatedHost(raw); if (!hosts.some(existing => existing.id === h.id)) hosts.push(h); } catch { /* skip corrupt host only */ } }
      return hosts;
    } catch { return []; }
  }
  async save(hosts: Host[]): Promise<void> {
    const data = JSON.stringify(hosts.map(validatedHost));
    if (this.bridge) {
      try { if (await this.bridge.setLocalStorage(KEY, data)) return; } catch { /* local fallback */ }
    }
    this.local.setItem(KEY, data);
  }
}
