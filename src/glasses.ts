import { CreateStartUpPageContainer, ListContainerProperty, ListItemContainerProperty, MenuContainerProperty, MenuItemProperty, OsEventTypeList, RebuildPageContainer, TextContainerProperty, TextContainerUpgrade, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { EvenAppBridge, EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { replyPages, truncateUTF8 } from './pagination';
import { ControllerStore, type State, type View } from './store';
import { providerName, slotName } from './types';

export type GlassesFrame = { kind: 'list' | 'text'; title: string; content: string; footer: string; items: string[]; context: string };
export function shortHeading(value: string, max = 42): string {
  let used = 0; let title = '';
  for (const char of value) {
    used += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
    if (used >= max) return title + '…';
    title += char;
  }
  return title;
}
export function glassesFrame(state: State, hostName: string): GlassesFrame {
  const prefix = state.demo ? 'DEMO / ' : '';
  const title = `${prefix}${hostName} / ${providerName(state.provider)}`;
  const targets = state.view === 'slots' ? state.slots.map(s => `${s.slot}:${s.kind}:${s.chatID ?? ''}`).join('|') : state.view === 'hosts' ? state.hosts.map(h => h.id).join('|') : '';
  const context = `${state.hostID ?? ''}:${state.demo}:${state.provider}:${state.view}:${state.selected?.id ?? ''}:${targets}`;
  if (state.error) return { kind: 'text', title, content: truncateUTF8(state.error, 850), footer: 'Double tap: chats  |  Menu: refresh', items: [], context: `${context}:error` };
  if (!state.hostID && !state.demo) return { kind: 'text', title: 'GENESIS G2', content: 'Your agents, within a glance.\n\nPair a computer in the phone app to get started.\n\nOr choose Explore preview on your phone.', footer: 'Independent Genesis reader', items: [], context: 'unpaired' };
  if (state.busy && !state.connected && state.view === 'slots') return { kind: 'text', title, content: 'Connecting to your computer…\n\nLoading available chats.', footer: 'GENESIS G2', items: [], context: `${context}:loading` };
  if (!state.connected && state.view === 'slots') return { kind: 'text', title, content: 'Computer not connected.\n\nCheck the Genesis bridge and Tailscale, then choose Refresh from the menu.', footer: 'Menu: refresh or computers', items: [], context: `${context}:offline` };
  if (state.view === 'hosts') return { kind: 'list', title: `${prefix}Choose computer`, content: '', footer: 'Swipe: choose  |  Tap: connect', items: state.hosts.length ? state.hosts.map(h => truncateUTF8(h.name, 63)) : ['Pair a computer on your phone'], context };
  if (state.view === 'providers') return { kind: 'list', title: `${prefix}Choose agent`, content: '', footer: 'Swipe: choose  |  Tap: select', items: ['Codex', 'Claude'], context };
  if (state.view === 'reader') {
    const pages = replyPages(state.reply?.text ?? (state.busy ? 'Opening chat…' : ''));
    const page = Math.min(state.page, pages.length - 1);
    const slot = state.selectedSlot ? `${slotName(state.provider, state.selectedSlot)} / ` : '';
    const phase = state.reply?.phase === 'commentary' ? 'Progress' : state.reply?.phase === 'partial_answer' ? 'Partial' : 'Reply';
    return { kind: 'text', title: `${prefix}${slot}${state.selected?.title ?? 'Latest reply'}`, content: pages[page], footer: `${phase} ${page + 1}/${pages.length}  Swipe: page | Double tap: chats${state.reply?.truncated ? ' (excerpt)' : ''}`, items: [], context };
  }
  return { kind: 'list', title, content: '', footer: state.busy ? 'Loading chats…' : 'Swipe: choose  |  Tap: open  |  Menu: more', items: state.slots.map(s => truncateUTF8(`${slotName(state.provider, s.slot)}  ${s.label}${s.kind === 'shortcut' ? ' [shortcut]' : ''}`, 63)), context };
}

export type Gesture = { action: 'select'; index?: number } | { action: 'turn'; delta: number; index?: number } | { action: 'back' | 'overlay-open' | 'overlay-close' | 'background' } | { action: 'menu'; id: number };
export function gestureFor(event: EvenHubEvent): Gesture | null {
  if (event.menuItemClickEvent?.itemID !== undefined) return { action: 'menu', id: event.menuItemClickEvent.itemID };
  const input = event.listEvent ?? event.textEvent ?? event.sysEvent;
  if (!input) return null;
  // Protobuf omits zero values. A current list click with no index selects the
  // first row, not the last phone-side focus before a native rebuild.
  const index = event.listEvent ? event.listEvent.currentSelectItemIndex ?? 0 : undefined;
  const selection = Number.isInteger(index) && index! >= 0 ? { index } : {};
  switch (input.eventType) {
    case undefined:
      // SDK can omit the zero-valued click enum. Never interpret an empty sysEvent
      // as a click: it has no captured container and can be unrelated telemetry.
      return event.listEvent || event.textEvent ? { action: 'select', ...selection } : null;
    case OsEventTypeList.CLICK_EVENT: return { action: 'select', ...selection };
    case OsEventTypeList.SCROLL_TOP_EVENT: return { action: 'turn', delta: -1, ...selection };
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: return { action: 'turn', delta: 1, ...selection };
    case OsEventTypeList.DOUBLE_CLICK_EVENT: return { action: 'back' };
    // These are the OS contextual-menu overlay, not app background lifecycle.
    case OsEventTypeList.FOREGROUND_ENTER_EVENT: return { action: 'overlay-open' };
    case OsEventTypeList.FOREGROUND_EXIT_EVENT: return { action: 'overlay-close' };
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT: return { action: 'background' };
    default: return null;
  }
}

export interface GlassesPort {
  createStartUpPageContainer(page: CreateStartUpPageContainer): Promise<number>;
  rebuildPageContainer(page: RebuildPageContainer): Promise<boolean>;
  textContainerUpgrade(page: TextContainerUpgrade): Promise<boolean>;
}
type ContainerIDs = { heading: number; body: number; footer: number };
const text = (id: number, name: string, y: number, height: number, content: string, capture = 0) => new TextContainerProperty({ containerID: id, containerName: name, xPosition: 8, yPosition: y, width: 560, height, content: truncateUTF8(content, 999), isEventCapture: capture, textColor: name === 'footer' ? 2 : 4, paddingLength: 0 });
export function pageFor(frame: GlassesFrame, ids: ContainerIDs = { heading: 1, body: 2, footer: 3 }): CreateStartUpPageContainer {
  const textObject = [text(ids.heading, 'heading', 6, 36, truncateUTF8(shortHeading(frame.title), 120)), text(ids.footer, 'footer', 256, 28, truncateUTF8(frame.footer, 95))];
  const listObject = [];
  if (frame.kind === 'text') textObject.push(text(ids.body, 'body', 48, 202, frame.content, 1));
  else listObject.push(new ListContainerProperty({ containerID: ids.body, containerName: 'choices', xPosition: 8, yPosition: 48, width: 560, height: 202, isEventCapture: 1, borderWidth: 0, paddingLength: 2, itemContainer: new ListItemContainerProperty({ itemCount: frame.items.length, itemWidth: 550, isItemSelectBorderEn: 1, itemName: frame.items }) }));
  return new CreateStartUpPageContainer({ containerTotalNum: textObject.length + listObject.length, textObject, listObject,
    menuObject: new MenuContainerProperty({ menuItems: [new MenuItemProperty({ itemID: 1, itemName: 'Chats' }), new MenuItemProperty({ itemID: 2, itemName: 'Computers' }), new MenuItemProperty({ itemID: 3, itemName: 'Agents' }), new MenuItemProperty({ itemID: 4, itemName: 'Refresh' })] }) });
}

// One write at a time; coalesce intermediate frames while Bluetooth is busy.
// Native list highlight is left alone when only phone focus changes.
export class GlassesRenderer {
  private pending: GlassesFrame | null = null;
  private last: GlassesFrame | null = null;
  private rendering = false;
  private created = false;
  private forceRebuild = false;
  private serial = 0;
  private ids: ContainerIDs = { heading: 1, body: 2, footer: 3 };
  private target: { context: string; kind: GlassesFrame['kind']; containerID: number } | null = null;
  get inputTarget() { return this.target; }
  constructor(private port: GlassesPort, private onError: (message: string) => void) {}
  reset() { this.created = false; this.last = null; this.target = null; }
  reconnect(frame: GlassesFrame) { this.forceRebuild = true; this.target = null; this.render(frame); }
  suspend() { this.pending = null; this.target = null; }
  render(frame: GlassesFrame) {
    // Revoke input immediately when target identity changes, before Bluetooth
    // acknowledges the replacement page. Old visible rows must not select new IDs.
    if (this.target?.context !== frame.context || this.target.kind !== frame.kind) this.target = null;
    this.pending = frame; void this.drain();
  }
  private async drain() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.pending) {
        const frame = this.pending; this.pending = null;
        const force = this.forceRebuild; this.forceRebuild = false;
        if (!force && JSON.stringify(frame) === JSON.stringify(this.last)) continue;
        if (force || !this.last || this.last.context !== frame.context || this.last.kind !== frame.kind) {
          const base = ++this.serial * 3;
          this.ids = { heading: base, body: base + 1, footer: base + 2 };
          this.target = null;
        }
        if (!this.created) {
          if (await this.port.createStartUpPageContainer(pageFor(frame, this.ids)) !== 0) throw new Error();
          this.created = true;
        } else if (!force && frame.kind === 'text' && this.last?.kind === 'text' && frame.context === this.last.context) {
          for (const [id, name, content, old] of [[this.ids.heading, 'heading', truncateUTF8(shortHeading(frame.title), 120), truncateUTF8(shortHeading(this.last.title), 120)], [this.ids.body, 'body', frame.content, this.last.content], [this.ids.footer, 'footer', truncateUTF8(frame.footer, 95), truncateUTF8(this.last.footer, 95)]] as const) {
            if (content !== old && !await this.port.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content }))) throw new Error();
          }
        } else if (!await this.port.rebuildPageContainer(new RebuildPageContainer(pageFor(frame, this.ids)))) throw new Error();
        this.last = frame;
        this.target = { context: frame.context, kind: frame.kind, containerID: this.ids.body };
      }
    } catch { this.last = null; this.pending = null; this.target = null; this.onError('The glasses could not update. Reconnect them in the Even app, then try Connect glasses.'); }
    finally { this.rendering = false; }
  }
}

export class GlassesController {
  private bridge: EvenAppBridge | null = null;
  private renderer: GlassesRenderer | null = null;
  private unsubscribe: (() => void) | null = null;
  private active = true;
  private connecting = false;
  constructor(private store: ControllerStore, private onStatus: (status: string, connected: boolean) => void, port?: GlassesPort) {
    if (port) this.renderer = new GlassesRenderer(port, message => this.onStatus(message, false));
  }
  async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    this.onStatus('Connecting to Even…', false);
    try {
      const bridge = await bounded(waitForEvenAppBridge(), 5000);
      const device = await bounded(bridge.getDeviceInfo(), 5000);
      if (!device?.status.isConnected()) throw new Error();
      this.bridge = bridge;
      this.unsubscribe?.();
      this.unsubscribe = bridge.onEvenHubEvent(event => this.handle(event));
      this.active = true;
      const frame = glassesFrame(this.store.state, this.store.host?.name ?? 'Pair a computer');
      if (this.renderer) this.renderer.reconnect(frame);
      else { this.renderer = new GlassesRenderer(bridge, message => this.onStatus(message, false)); this.renderer.render(frame); }
      this.onStatus('Even glasses connected', true);
    } catch { this.onStatus('Open Genesis G2 in the Even app with your glasses connected.', false); }
    finally { this.connecting = false; }
  }
  render(state: State) { if (this.active) this.renderer?.render(glassesFrame(state, this.store.host?.name ?? 'Pair a computer')); }
  private count(view: View) { return view === 'hosts' ? this.store.state.hosts.length : view === 'providers' ? 2 : 6; }
  handle(event: EvenHubEvent, preview = false) {
    const gesture = gestureFor(event); if (!gesture) return;
    const state = this.store.state;
    if (gesture.action === 'background') { this.active = false; this.renderer?.suspend(); return; }
    if (gesture.action === 'overlay-open' || gesture.action === 'overlay-close') return;
    if (!preview) {
      if (!this.active) return;
      const frame = glassesFrame(state, this.store.host?.name ?? 'Pair a computer');
      const target = this.renderer?.inputTarget;
      if (!target || target.context !== frame.context || target.kind !== frame.kind) return;
      const input = event.listEvent ?? event.textEvent;
      if (input && input.containerID !== target.containerID) return;
      if (event.listEvent && target.kind !== 'list' || event.textEvent && target.kind !== 'text') return;
      // An unscoped sys click cannot establish which chat was visible.
      if (event.sysEvent && (gesture.action === 'select' || gesture.action === 'turn')) return;
    }
    if (gesture.action === 'menu') {
      if (gesture.id === 4) void this.store.refresh();
      else { const view = ({ 1: 'slots', 2: 'hosts', 3: 'providers' } as Record<number, View>)[gesture.id]; if (view) this.store.navigate(view); }
      return;
    }
    if (gesture.action === 'back') {
      if (state.view === 'slots' && !state.error) void this.bridge?.shutDownPageContainer(1);
      else this.store.back();
      return;
    }
    if (state.error) { if (gesture.action === 'select') void this.store.refresh(); return; }
    if (gesture.action === 'turn') {
      if (state.view === 'reader') this.store.turnPage(gesture.delta, replyPages(state.reply?.text ?? '').length);
      else if (gesture.index !== undefined) this.store.focus(gesture.index, this.count(state.view));
      else this.store.turn(gesture.delta, this.count(state.view));
      return;
    }
    if (gesture.action !== 'select') return;
    if (state.view === 'reader') { this.store.turnPage(1, replyPages(state.reply?.text ?? '').length); return; }
    const index = gesture.index ?? state.focus;
    if (state.view === 'hosts') { const host = state.hosts[index]; if (host) void this.store.setHost(host.id); }
    else if (state.view === 'providers') { if (index === 0 || index === 1) void this.store.setProvider(index === 0 ? 'codex' : 'claude'); }
    else if (index >= 0 && index < 6) void this.store.openSlot(index + 1);
  }
}
export function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timeout')), ms); promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
}
