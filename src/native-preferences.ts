import { canonicalEvenOrigin } from './origin-recovery';
import type { StoragePort } from './storage';

export const BACKGROUND_RELAY_KEY = 'genesis-g2.background-relay.v1';
type Options = { nativeAvailable: () => boolean; origin: () => string; apply: (enabled: boolean) => void; saved?: (saved: boolean) => void; timeoutMs?: number };
function timed<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preference storage timed out.')), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** Restores an explicit Beta opt-in, never permission to run when iOS suspends Even. */
export class NativeBackgroundPreference {
  private bridge: StoragePort | null = null;
  private revision = 0;
  private choice: boolean | null = null;
  private writes: Promise<boolean> = Promise.resolve(true);
  private binding: Promise<boolean> | null = null;
  constructor(private options: Options) {}
  private available() { return this.options.nativeAvailable() && canonicalEvenOrigin(this.options.origin()); }
  async bindBridge(bridge: StoragePort): Promise<boolean> {
    if (!this.available()) return false;
    if (this.bridge === bridge) return true;
    if (this.binding) return this.binding;
    const revision = this.revision;
    this.binding = (async () => {
      try {
        const raw = await timed(bridge.getLocalStorage(BACKGROUND_RELAY_KEY), this.options.timeoutMs ?? 3000);
        if (!this.available()) return false;
        this.bridge = bridge;
        if (revision === this.revision && this.choice === null && raw) {
          const value: unknown = JSON.parse(raw);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const preference = value as Record<string, unknown>;
            if (preference.version === 1 && typeof preference.backgroundRelay === 'boolean') this.options.apply(preference.backgroundRelay);
          }
        }
        if (this.choice !== null) {
          const revision = this.revision; const saved = await this.persist(this.choice);
          if (revision === this.revision) this.options.saved?.(saved);
          return saved;
        }
        return true;
      } catch { return false; }
    })();
    try { return await this.binding; } finally { this.binding = null; }
  }
  async set(enabled: boolean): Promise<boolean> {
    const revision = ++this.revision; this.choice = enabled;
    const saved = await this.persist(enabled);
    if (revision === this.revision) this.options.saved?.(saved);
    return saved;
  }
  private async persist(enabled: boolean): Promise<boolean> {
    const bridge = this.bridge;
    if (!bridge || !this.available()) return false;
    const raw = JSON.stringify({ version: 1, backgroundRelay: enabled });
    const run = async () => {
      if (this.bridge !== bridge || !this.available()) return false;
      try { return await bridge.setLocalStorage(BACKGROUND_RELAY_KEY, raw) === true; } catch { return false; }
    };
    // Keep the raw write serialized even when a waiting UI call times out.
    this.writes = this.writes.then(run, run);
    try { return await timed(this.writes, this.options.timeoutMs ?? 3000); } catch { return false; }
  }
}
