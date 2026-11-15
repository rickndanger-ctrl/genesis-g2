import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_RELAY_KEY, NativeBackgroundPreference } from '../src/native-preferences';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function setup(raw = '') {
  const data = new Map(raw ? [[BACKGROUND_RELAY_KEY, raw]] : []);
  const bridge = { getLocalStorage: vi.fn(async (key: string) => data.get(key) ?? ''), setLocalStorage: vi.fn(async (key: string, value: string) => { data.set(key, value); return true; }) };
  const apply = vi.fn(); const saved = vi.fn(); let native = true; let origin = 'http://127.0.0.1:51001';
  const make = () => new NativeBackgroundPreference({ nativeAvailable: () => native, origin: () => origin, apply, saved, timeoutMs: 20 });
  return { data, bridge, apply, saved, make, setNative: (value: boolean) => { native = value; }, setOrigin: (value: string) => { origin = value; } };
}
describe('explicit native Beta background relay preference', () => {
  it('keeps first use off and restores only an explicit saved choice on a new launch', async () => {
    const f = setup(); const first = f.make(); await first.bindBridge(f.bridge);
    expect(f.apply).not.toHaveBeenCalled(); expect(f.bridge.setLocalStorage).not.toHaveBeenCalled();
    expect(await first.set(true)).toBe(true); await f.make().bindBridge(f.bridge);
    expect(f.apply).toHaveBeenLastCalledWith(true);
    expect(await first.set(false)).toBe(true); await f.make().bindBridge(f.bridge);
    expect(f.apply).toHaveBeenLastCalledWith(false);
    expect([...f.data.keys()]).toEqual([BACKGROUND_RELAY_KEY]);
  });
  it.each(['', '{bad', '{"version":1,"backgroundRelay":"true"}', '{"version":2,"backgroundRelay":true}'])('never infers opt-in from missing or malformed storage: %s', async raw => {
    const f = setup(raw); await f.make().bindBridge(f.bridge); expect(f.apply).not.toHaveBeenCalled(); expect(f.bridge.setLocalStorage).not.toHaveBeenCalled();
  });
  it('does not persist or restore a browser or HTTPS QR preview choice', async () => {
    const f = setup('{"version":1,"backgroundRelay":true}'); f.setNative(false);
    const preference = f.make(); expect(await preference.bindBridge(f.bridge)).toBe(false); expect(await preference.set(true)).toBe(false);
    f.setNative(true); f.setOrigin('https://g2.example.test'); expect(await preference.bindBridge(f.bridge)).toBe(false);
    expect(f.apply).not.toHaveBeenCalled(); expect(f.bridge.getLocalStorage).not.toHaveBeenCalled(); expect(f.bridge.setLocalStorage).not.toHaveBeenCalled();
  });
  it('does not let a late saved true overwrite a fresh opt-out', async () => {
    const f = setup(); const held = deferred<string>(); f.bridge.getLocalStorage.mockReturnValueOnce(held.promise);
    const preference = f.make(); const binding = preference.bindBridge(f.bridge); await preference.set(false);
    held.resolve('{"version":1,"backgroundRelay":true}'); expect(await binding).toBe(true);
    expect(f.apply).not.toHaveBeenCalled(); expect(JSON.parse(f.data.get(BACKGROUND_RELAY_KEY)!)).toEqual({ version: 1, backgroundRelay: false });
  });
  it('serializes fast toggles past a timed-out native write so the final choice wins', async () => {
    const f = setup(); const preference = f.make(); await preference.bindBridge(f.bridge);
    const held = deferred<boolean>(); const original = f.bridge.setLocalStorage.getMockImplementation()!;
    f.bridge.setLocalStorage.mockImplementationOnce(async (key, value) => { await held.promise; return original(key, value); });
    expect(await preference.set(true)).toBe(false); expect(await preference.set(false)).toBe(false);
    expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(1);
    held.resolve(true); await tick(); await tick(); expect(f.bridge.setLocalStorage).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.data.get(BACKGROUND_RELAY_KEY)!)).toEqual({ version: 1, backgroundRelay: false });
  });
  it('does not report a failed native write as saved', async () => {
    const f = setup(); const preference = f.make(); await preference.bindBridge(f.bridge); f.bridge.setLocalStorage.mockResolvedValue(false);
    expect(await preference.set(true)).toBe(false); expect(f.data.has(BACKGROUND_RELAY_KEY)).toBe(false); expect(f.saved).toHaveBeenLastCalledWith(false);
  });
  it('does not let a stale failed save override the latest preference status', async () => {
    const f = setup(); const preference = f.make(); await preference.bindBridge(f.bridge);
    const held = deferred<boolean>(); f.bridge.setLocalStorage.mockReturnValueOnce(held.promise);
    const first = preference.set(true); const second = preference.set(false);
    held.resolve(false); await Promise.all([first, second]);
    expect(f.saved.mock.calls).toEqual([[true]]);
  });
});
