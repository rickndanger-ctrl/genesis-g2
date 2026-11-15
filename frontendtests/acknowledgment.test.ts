import { describe, expect, it, vi } from 'vitest';
import { EvenAppBridge, TextContainerUpgrade } from '@evenrealities/even_hub_sdk';
import { acknowledgmentData, GlassesRenderer, pageFor } from '../src/glasses';
import type { GlassesFrame, GlassesPort } from '../src/glasses';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const frame: GlassesFrame = { kind: 'text', title: 'A1', content: 'First chat', footer: 'Reply 1/1', items: [], context: 'first-chat' };
const fixture = () => ({ createStartUpPageContainer: vi.fn(async () => 0), rebuildPageContainer: vi.fn(async () => true), textContainerUpgrade: vi.fn(async () => true) });
const invalidAcks = [false, 0, 1, 'true', 'false', { success: false }, { success: true }, {}, null, undefined];

describe('strict SDK acknowledgment contract', () => {
  it('demonstrates that the SDK typed boolean wrappers do not validate native return values', async () => {
    for (const raw of [1, 'false', { success: false }]) {
      const transport = { callEvenApp: vi.fn(async () => raw) };
      expect(await EvenAppBridge.prototype.rebuildPageContainer.call(transport as never, pageFor(frame))).toEqual(raw);
      expect(await EvenAppBridge.prototype.textContainerUpgrade.call(transport as never, new TextContainerUpgrade({ containerID: 4, containerName: 'body', content: 'Second chat' }))).toEqual(raw);
    }
  });
  it.each(invalidAcks)('rejects a non-true context rebuild ACK: %j', async raw => {
    const port = fixture(); const error = vi.fn(); const diagnostic = vi.fn(); const acknowledged = vi.fn();
    const renderer = new GlassesRenderer(port, error, diagnostic, acknowledged);
    renderer.render(frame); await tick(); acknowledged.mockClear();
    port.rebuildPageContainer.mockResolvedValueOnce(raw as never);
    renderer.render({ ...frame, title: 'A2', content: 'Second chat', context: 'second-chat' }); await tick();
    expect(error).toHaveBeenCalledTimes(1); expect(acknowledged).not.toHaveBeenCalled(); expect(renderer.inputTarget).toBeNull();
    expect(diagnostic).toHaveBeenCalledWith('page_ack', expect.objectContaining({ phase: 2, ack: 0, ...acknowledgmentData(raw) }));
  });
  it.each(invalidAcks)('rejects a non-true in-place body ACK: %j', async raw => {
    const port = fixture(); const error = vi.fn(); const acknowledged = vi.fn();
    const renderer = new GlassesRenderer(port, error, () => {}, acknowledged);
    renderer.render(frame); await tick(); acknowledged.mockClear();
    port.textContainerUpgrade.mockResolvedValueOnce(raw as never);
    renderer.render({ ...frame, content: 'Replacement text' }); await tick();
    expect(error).toHaveBeenCalledTimes(1); expect(acknowledged).not.toHaveBeenCalled(); expect(renderer.inputTarget).toBeNull();
  });
  it.each(invalidAcks)('rejects non-true recovery after startup invalid code: %j', async raw => {
    const port = fixture(); port.createStartUpPageContainer.mockResolvedValueOnce(1); port.rebuildPageContainer.mockResolvedValueOnce(raw as never);
    const error = vi.fn(); const acknowledged = vi.fn(); const renderer = new GlassesRenderer(port, error, () => {}, acknowledged);
    renderer.render(frame); await tick();
    expect(error).toHaveBeenCalledTimes(1); expect(acknowledged).not.toHaveBeenCalled(); expect(renderer.inputTarget).toBeNull();
  });
  it('still accepts numeric startup0 and literal boolean true for recovery, rebuild and update', async () => {
    const port = fixture(); port.createStartUpPageContainer.mockResolvedValueOnce(1);
    const error = vi.fn(); const acknowledged = vi.fn(); const renderer = new GlassesRenderer(port, error, () => {}, acknowledged);
    renderer.render(frame); await tick(); renderer.render({ ...frame, context: 'second-chat', title: 'A2' }); await tick(); renderer.render({ ...frame, context: 'second-chat', title: 'A2', content: 'Replacement' }); await tick();
    expect(acknowledged).toHaveBeenCalledTimes(3); expect(error).not.toHaveBeenCalled();
    const clean = new GlassesRenderer(fixture(), error, () => {}, acknowledged); clean.render(frame); await tick();
    expect(acknowledged).toHaveBeenCalledTimes(4); expect(error).not.toHaveBeenCalled();
  });
  it('records only bounded numeric primitive codes and type enums, never native payload text', () => {
    for (const value of ['private-native-message', { message: 'private-native-message', token: 'never-log' }, NaN, Infinity, -100, 2147483648]) {
      const data = acknowledgmentData(value); expect(data.reason).toBe(-1); expect(Object.values(data).every(n => Number.isInteger(n) && n! >= -1 && n! <= 2147483647)).toBe(true); expect(JSON.stringify(data)).not.toContain('private'); expect(JSON.stringify(data)).not.toContain('never-log');
    }
    expect(acknowledgmentData(true)).toEqual({ status: 1, reason: 1 }); expect(acknowledgmentData(false)).toEqual({ status: 1, reason: 0 });
    expect(acknowledgmentData(3)).toEqual({ status: 2, reason: 3 }); expect(acknowledgmentData('false')).toEqual({ status: 3, reason: -1 });
  });
  it('rebuilds repeated chat identities and discards intermediate frames while Bluetooth is pending', async () => {
    const sent: { kind: string; body: string; id: number }[] = []; let resolve!: (value: boolean) => void;
    const held = new Promise<boolean>(done => { resolve = done; }); let count = 0;
    const port: GlassesPort = {
      createStartUpPageContainer: async page => { const body = page.textObject!.find(x => x.containerName === 'body')!; sent.push({ kind: 'create', body: body.content!, id: body.containerID! }); return 0; },
      rebuildPageContainer: async page => { const body = page.textObject!.find(x => x.containerName === 'body')!; sent.push({ kind: 'rebuild', body: body.content!, id: body.containerID! }); return ++count === 1 ? held : true; },
      textContainerUpgrade: async text => { sent.push({ kind: text.containerName!, body: text.content!, id: text.containerID! }); return true; },
    };
    const error = vi.fn(); const renderer = new GlassesRenderer(port, error);
    renderer.render(frame); await tick();
    renderer.render({ ...frame, context: 'second-chat', title: 'A2', content: 'Second loading' });
    renderer.render({ ...frame, context: 'second-chat', title: 'A2', content: 'Second reply' });
    renderer.render({ ...frame, context: 'first-chat', content: 'First newest reply' });
    resolve(true); await tick();
    expect(sent.map(x => x.body)).toEqual(['First chat', 'Second loading', 'First newest reply']);
    expect(new Set(sent.map(x => x.id)).size).toBe(3); expect(error).not.toHaveBeenCalled(); expect(renderer.inputTarget?.context).toBe('first-chat');
  });
});
