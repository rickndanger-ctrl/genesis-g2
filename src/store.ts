import { GatewayError } from './api';
import { DEMO_HOST, DemoGateway } from './demo';
import type { Availability, Chat, Gateway, Host, HostStatus, OpenResult, Provider, Reply, Slot } from './types';

export type View = 'slots' | 'reader' | 'hosts' | 'providers';
export type State = {
  hosts: Host[]; hostID: string | null; provider: Provider; demo: boolean;
  status: HostStatus | null; slots: Slot[]; chats: Chat[]; selected: Chat | null;
  selectedSlot: number | null; reply: Reply | null; page: number; view: View; focus: number;
  busy: boolean; connected: boolean; error: string | null; openStatus: OpenResult['status'] | null;
};
const emptySlots = (): Slot[] => Array.from({ length: 6 }, (_, i) => ({ slot: i + 1, label: 'Unassigned', chatID: null, kind: 'empty' }));
const message = (error: unknown) => error instanceof GatewayError ? error.message : 'The request could not be completed. Refresh to try again.';

export class ControllerStore {
  state: State;
  private listeners = new Set<(state: State) => void>();
  private route = 0;
  private connection = new AbortController();
  private selection = new AbortController();
  private replyInFlight = false;
  private replyGeneration = 0;
  // Physical UI opening commands cannot be undone by aborting fetch. Queue them so
  // an older open cannot finish after a newer open on the same bridge.
  private opens: Promise<void> = Promise.resolve();
  private demoGateway = new DemoGateway();
  constructor(private gateway: Gateway, hosts: Host[] = []) {
    this.state = { hosts, hostID: hosts[0]?.id ?? null, provider: 'codex', demo: false, status: null, slots: emptySlots(), chats: [], selected: null, selectedSlot: null, reply: null, page: 0, view: 'slots', focus: 0, busy: false, connected: false, error: null, openStatus: null };
  }
  get host(): Host | null { return this.state.demo ? DEMO_HOST : this.state.hosts.find(h => h.id === this.state.hostID) ?? null; }
  get availability(): Availability | undefined { return this.state.status?.providers.find(p => p.id === this.state.provider); }
  private get api(): Gateway { return this.state.demo ? this.demoGateway : this.gateway; }
  subscribe(listener: (state: State) => void): () => void { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) listener(this.state); }
  private resetRoute() {
    this.route++; this.connection.abort(); this.selection.abort();
    this.connection = new AbortController(); this.selection = new AbortController();
    this.replyGeneration++; this.replyInFlight = false;
    Object.assign(this.state, { status: null, slots: emptySlots(), chats: [], selected: null, selectedSlot: null, reply: null, page: 0, view: 'slots', focus: 0, error: null, connected: false, openStatus: null, busy: false });
  }
  async setHost(id: string) { if (!this.state.hosts.some(h => h.id === id)) return; this.resetRoute(); this.state.hostID = id; this.state.demo = false; this.emit(); await this.refresh(); }
  async setProvider(provider: Provider) { if (provider === this.state.provider) { this.navigate('slots'); return; } this.resetRoute(); this.state.provider = provider; this.emit(); await this.refresh(); }
  async setDemo(enabled: boolean) { this.resetRoute(); this.state.demo = enabled; this.emit(); await this.refresh(); }
  async setHosts(hosts: Host[], selectedID?: string) {
    this.resetRoute(); this.state.hosts = hosts; this.state.hostID = selectedID ?? (hosts.some(h => h.id === this.state.hostID) ? this.state.hostID : hosts[0]?.id ?? null); this.state.demo = false; this.emit(); await this.refresh();
  }
  async refresh() {
    if (this.state.view === 'reader' && this.state.selected) { await this.refreshReply(); return; }
    const host = this.host; if (!host) { this.emit(); return; }
    const route = ++this.route;
    this.connection.abort(); this.connection = new AbortController();
    const signal = this.connection.signal; const api = this.api; const provider = this.state.provider;
    this.state.busy = true; this.state.error = null; this.emit();
    try {
      const status = await api.status(host, signal);
      if (route !== this.route) return;
      this.state.status = status; this.state.connected = true;
      const available = status.providers.find(p => p.id === provider);
      if (!available?.available) {
        this.state.slots = emptySlots(); this.state.chats = [];
        this.state.error = available?.reason || `${provider === 'codex' ? 'Codex' : 'Claude'} is not available on this computer.`;
        return;
      }
      const [profile, chats] = await Promise.all([api.profile(host, provider, signal), api.chats(host, provider, signal)]);
      if (route !== this.route) return;
      if (profile.provider !== provider || chats.provider !== provider) throw new GatewayError('wrong_route', 'The bridge returned a different agent. Refresh before opening a chat.');
      this.state.slots = emptySlots().map(slot => profile.slots.find(s => s.slot === slot.slot) ?? slot);
      this.state.chats = chats.chats;
    } catch (error) {
      if (route === this.route && !signal.aborted) { this.state.connected = false; this.state.error = message(error); }
    } finally { if (route === this.route) { this.state.busy = false; this.emit(); } }
  }
  async openSlot(slot: number) {
    const item = this.state.slots.find(s => s.slot === slot);
    if (!item || item.kind !== 'chat' || !item.chatID) {
      this.state.error = item?.kind === 'shortcut' ? 'This slot is a shortcut. Genesis G2 currently opens chats and reads replies; use the existing controller for this action.' : 'This slot has no assigned chat. Choose a chat from the list below, or map this slot in your Genesis controller.';
      this.emit(); return;
    }
    const chat = this.state.chats.find(c => c.id === item.chatID) ?? { id: item.chatID, title: item.label };
    await this.openChat(chat, slot);
  }
  async openChat(chat: Chat, slot?: number) {
    const host = this.host; if (!host || !this.state.connected || !this.availability?.available) return;
    this.selection.abort(); this.selection = new AbortController();
    const signal = this.selection.signal; const route = ++this.route; const provider = this.state.provider; const api = this.api;
    this.replyGeneration++; this.replyInFlight = false;
    Object.assign(this.state, { selected: chat, selectedSlot: slot ?? null, reply: null, page: 0, view: 'reader', error: null, busy: true, openStatus: null });
    this.emit();
    let read: Promise<void> = Promise.resolve();
    const run = async () => {
      if (route !== this.route || signal.aborted) return;
      try {
        // Do not abort an already sent open merely because the user selected a
        // different chat; wait for its acknowledgment before the queued open.
        const result = await api.open(host, provider, chat, slot, this.connection.signal);
        if (route !== this.route || signal.aborted) return;
        if (result.chat.id !== chat.id) throw new GatewayError('wrong_chat', 'The computer returned a different chat. Nothing will be shown until you refresh.');
        this.state.openStatus = result.status; this.state.selected = result.chat;
        // Only the physical open command belongs to the queue. A slow read must
        // never delay the next chat selection; its result is route-guarded.
        read = this.refreshReply().finally(() => { if (route === this.route) { this.state.busy = false; this.emit(); } });
      } catch (error) { if (route === this.route && !signal.aborted) { this.state.error = message(error); this.state.busy = false; this.emit(); } }
    };
    this.opens = this.opens.then(run, run);
    await this.opens;
    await read;
  }
  async refreshReply() {
    const host = this.host; const selected = this.state.selected;
    if (!host || !selected || this.replyInFlight) return;
    if (!this.availability?.canReadReply) { this.state.error = this.availability?.reason || 'Chat switching is available. Reading replies for this agent is not connected in this preview.'; this.emit(); return; }
    const route = this.route; const generation = ++this.replyGeneration; const provider = this.state.provider; const signal = this.selection.signal;
    this.replyInFlight = true;
    try {
      const reply = await this.api.reply(host, provider, selected.id, signal);
      if (route !== this.route || generation !== this.replyGeneration || signal.aborted) return;
      if (reply.chatID !== selected.id || reply.provider !== provider) throw new GatewayError('wrong_chat', 'A reply arrived for a different chat and was ignored. Refresh to try again.');
      this.state.reply = reply; this.state.error = null;
    } catch (error) { if (route === this.route && !signal.aborted) this.state.error = message(error); }
    finally { if (generation === this.replyGeneration) { this.replyInFlight = false; this.emit(); } }
  }
  navigate(view: View) { this.state.view = view; this.state.focus = 0; this.state.error = null; this.emit(); }
  focus(index: number, count: number) { this.state.focus = Math.max(0, Math.min(count - 1, index)); this.emit(); }
  turn(delta: number, count: number) { this.focus(this.state.focus + delta, count); }
  turnPage(delta: number, total: number) { this.state.page = Math.max(0, Math.min(Math.max(0, total - 1), this.state.page + delta)); this.emit(); }
  back() { this.navigate('slots'); }
  clearError() { this.state.error = null; this.emit(); }
  dispose() { this.route++; this.connection.abort(); this.selection.abort(); this.listeners.clear(); }
}
