import { GatewayError } from './api';
import { DEMO_HOST, DemoGateway } from './demo';
import type { Availability, Chat, FollowFeedback, FollowSession, Gateway, Host, HostStatus, OpenResult, Provider, Reply, Slot } from './types';

export type View = 'slots' | 'reader' | 'hosts' | 'providers';
export type State = {
  hosts: Host[]; hostID: string | null; provider: Provider; demo: boolean;
  status: HostStatus | null; slots: Slot[]; chats: Chat[]; selected: Chat | null;
  selectedSlot: number | null; reply: Reply | null; page: number; view: View; focus: number;
  busy: boolean; connected: boolean; error: string | null; openStatus: OpenResult['status'] | null;
  follow: FollowSession | null; followEnabled: boolean; followNotice: string | null; followEnded: boolean;
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
  private followEpoch = 0;
  private followRequest = new AbortController();
  private followInFlight = false;
  private followExpiry: ReturnType<typeof setTimeout> | null = null;
  private lastFollowReplyAt = 0;
  private lastFeedback = '';
  private feedbackPending = new Map<string, number>();
  private feedbackQueuedKey = '';
  private acknowledgedFrame: { feedback: FollowFeedback; hostID: string; sourceID: string } | null = null;
  private feedbackQueue: Promise<void> = Promise.resolve();
  // Physical UI opening commands cannot be undone by aborting fetch. Queue them so
  // an older open cannot finish after a newer open on the same bridge.
  private opens: Promise<void> = Promise.resolve();
  private demoGateway = new DemoGateway();
  constructor(private gateway: Gateway, hosts: Host[] = []) {
    this.state = { hosts, hostID: hosts[0]?.id ?? null, provider: 'codex', demo: false, status: null, slots: emptySlots(), chats: [], selected: null, selectedSlot: null, reply: null, page: 0, view: 'slots', focus: 0, busy: false, connected: false, error: null, openStatus: null, follow: null, followEnabled: true, followNotice: null, followEnded: false };
  }
  get host(): Host | null { return this.state.demo ? DEMO_HOST : this.state.hosts.find(h => h.id === this.state.hostID) ?? null; }
  get availability(): Availability | undefined { return this.state.status?.providers.find(p => p.id === this.state.provider); }
  get manualControlsPaused() { return Boolean(this.state.follow || this.state.followEnded); }
  private get api(): Gateway { return this.state.demo ? this.demoGateway : this.gateway; }
  subscribe(listener: (state: State) => void): () => void { this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) listener(this.state); }
  private invalidateFollow() {
    this.followEpoch++; this.followRequest.abort(); this.followRequest = new AbortController(); this.followInFlight = false; this.lastFeedback = ''; this.acknowledgedFrame = null;
    if (this.followExpiry) clearTimeout(this.followExpiry); this.followExpiry = null;
  }
  private clearSelection() {
    this.route++; this.selection.abort(); this.selection = new AbortController();
    this.replyGeneration++; this.replyInFlight = false; this.lastFollowReplyAt = 0;
    Object.assign(this.state, { selected: null, selectedSlot: null, reply: null, page: 0, view: 'slots', focus: 0, busy: false, error: null, openStatus: null });
  }
  private resetRoute() {
    this.invalidateFollow();
    this.route++; this.connection.abort(); this.selection.abort();
    this.connection = new AbortController(); this.selection = new AbortController();
    this.replyGeneration++; this.replyInFlight = false;
    Object.assign(this.state, { status: null, slots: emptySlots(), chats: [], selected: null, selectedSlot: null, reply: null, page: 0, view: 'slots', focus: 0, error: null, connected: false, openStatus: null, busy: false, follow: null, followEnabled: true, followNotice: null, followEnded: false });
  }
  async setHost(id: string) { if (!this.state.hosts.some(h => h.id === id)) return; this.resetRoute(); this.state.hostID = id; this.state.demo = false; this.emit(); await this.refresh(); }
  async setProvider(provider: Provider) { if (this.manualControlsPaused) return; if (provider === this.state.provider) { this.navigate('slots'); return; } const followEnabled = this.state.followEnabled; this.resetRoute(); this.state.followEnabled = followEnabled; this.state.provider = provider; this.emit(); await this.refresh(); }
  async setDemo(enabled: boolean) { this.resetRoute(); this.state.demo = enabled; this.emit(); await this.refresh(); }
  async setHosts(hosts: Host[], selectedID?: string) {
    this.resetRoute(); this.state.hosts = hosts; this.state.hostID = selectedID ?? (hosts.some(h => h.id === this.state.hostID) ? this.state.hostID : hosts[0]?.id ?? null); this.state.demo = false; this.emit(); await this.refresh();
  }
  async refresh() {
    if (this.state.follow) { await this.pollFollow(); await this.refreshReply(); return; }
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
    if (this.manualControlsPaused) return;
    const item = this.state.slots.find(s => s.slot === slot);
    if (!item || item.kind !== 'chat' || !item.chatID) {
      this.state.error = item?.kind === 'shortcut' ? 'This slot is a shortcut. Genesis G2 currently opens chats and reads replies; use the existing controller for this action.' : 'This slot has no assigned chat. Choose a chat from the list below, or map this slot in your Genesis controller.';
      this.emit(); return;
    }
    const chat = this.state.chats.find(c => c.id === item.chatID) ?? { id: item.chatID, title: item.label };
    await this.openChat(chat, slot);
  }
  async openChat(chat: Chat, slot?: number) {
    if (this.manualControlsPaused) return;
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
    if (this.state.follow && (this.state.follow.state.view !== 'reply' || this.state.provider !== 'codex')) return;
    if (!this.state.follow && !this.availability?.canReadReply) { this.state.error = this.availability?.reason || 'Chat switching is available. Reading replies for this agent is not connected in this preview.'; this.emit(); return; }
    const route = this.route; const generation = ++this.replyGeneration; const provider = this.state.provider; const signal = this.selection.signal;
    this.replyInFlight = true;
    if (this.state.follow) this.lastFollowReplyAt = Date.now();
    try {
      const reply = await this.api.reply(host, provider, selected.id, signal);
      if (route !== this.route || generation !== this.replyGeneration || signal.aborted) return;
      if (reply.chatID !== selected.id || reply.provider !== provider) throw new GatewayError('wrong_chat', 'A reply arrived for a different chat and was ignored. Refresh to try again.');
      this.state.reply = reply; this.state.error = null;
    } catch (error) { if (route === this.route && !signal.aborted) this.state.error = message(error); }
    finally { if (generation === this.replyGeneration) { this.replyInFlight = false; this.emit(); } }
  }
  async pollFollow() {
    this.expireFollow();
    const host = this.host;
    if (!host || this.state.demo || !this.state.followEnabled || !this.api.follow || this.followInFlight) return;
    const epoch = this.followEpoch; const signal = this.followRequest.signal;
    this.followInFlight = true;
    try {
      const snapshot = await this.api.follow(host, signal);
      if (epoch !== this.followEpoch || signal.aborted || !this.state.followEnabled) return;
      if (this.state.status && snapshot.hostID !== this.state.status.host.id) throw new GatewayError('wrong_host', 'Native follow returned a different computer and was ignored.');
      if (!snapshot.active || Date.parse(snapshot.expiresAt) <= Date.now()) {
        if (this.state.follow) this.endFollow('Native follow ended. Enable Follow this controller in Genesis to reconnect.');
        else if (!snapshot.active && snapshot.supported === false && this.state.followNotice !== 'Update the Genesis companion to enable native follow.') { this.state.followNotice = 'Update the Genesis companion to enable native follow.'; this.emit(); }
        return;
      }
      this.applyFollow(snapshot);
    } catch (error) {
      if (epoch !== this.followEpoch || signal.aborted) return;
      // A lost network must not leave a private draft on display indefinitely.
      if (this.state.follow) this.endFollow('Native follow disconnected. Reconnect Genesis and Tailscale to continue.');
      else if (this.state.followNotice && this.state.followNotice !== message(error)) { this.state.followNotice = message(error); this.emit(); }
    } finally { if (epoch === this.followEpoch) this.followInFlight = false; }
  }
  private applyFollow(session: FollowSession) {
    const previous = this.state.follow; const target = (s: FollowSession) => `${s.sourceID}:${s.state.provider}:${s.state.chatID ?? ''}:${s.state.view}:${s.state.refreshNonce}`;
    const changed = !previous || target(previous) !== target(session);
    if (changed) {
      this.connection.abort(); this.connection = new AbortController(); this.clearSelection(); this.lastFeedback = '';
      if (this.state.provider !== session.state.provider) { this.state.slots = emptySlots(); this.state.chats = []; }
    }
    this.state.follow = session; this.state.followNotice = null; this.state.followEnded = false; this.state.connected = true;
    if (!session.feedback?.connected) this.lastFeedback = '';
    this.state.provider = session.state.provider; this.state.page = session.state.page;
    this.state.selected = session.state.chatID ? { id: session.state.chatID, title: session.chatTitle ?? this.state.chats.find(c => c.id === session.state.chatID)?.title ?? `Selected ${session.state.provider === 'codex' ? 'Codex' : 'Claude'} chat` } : null;
    this.state.selectedSlot = session.state.slotIndex === null ? null : session.state.slotIndex + 1;
    this.state.view = session.state.view === 'home' ? 'slots' : 'reader'; this.state.openStatus = null;
    if (this.followExpiry) clearTimeout(this.followExpiry);
    this.followExpiry = setTimeout(() => this.expireFollow(), Math.max(0, Date.parse(session.expiresAt) - Date.now()) + 1);
    if (!session.feedback?.connected || !previous || JSON.stringify(previous) !== JSON.stringify(session)) this.emit();
    if (session.state.view === 'reply' && session.state.provider === 'codex' && (changed || Date.now() - this.lastFollowReplyAt >= 5000)) void this.refreshReply();
  }
  expireFollow(now = Date.now()) {
    if (this.state.follow && Date.parse(this.state.follow.expiresAt) <= now) this.endFollow('Native follow expired. Enable Follow this controller in Genesis to reconnect.');
  }
  private endFollow(notice: string) {
    void this.disconnectFollowDisplay();
    this.clearSelection(); this.state.follow = null; this.state.followNotice = notice; this.state.followEnded = true; this.lastFeedback = ''; this.acknowledgedFrame = null;
    if (this.followExpiry) clearTimeout(this.followExpiry); this.followExpiry = null;
    this.emit();
  }
  async leaveFollow() {
    void this.disconnectFollowDisplay();
    this.invalidateFollow(); this.clearSelection(); this.state.follow = null; this.state.followEnabled = false; this.state.followEnded = false;
    this.state.followNotice = 'Manual glasses controls. The native controller keeps its session.'; this.emit(); await this.refresh();
  }
  async resumeFollow() {
    this.invalidateFollow(); this.clearSelection(); this.state.follow = null; this.state.followEnabled = true; this.state.followEnded = false;
    this.state.followNotice = 'Waiting for Follow this controller in Genesis.'; this.emit(); await this.pollFollow();
  }
  async acknowledgeFollow(feedback: FollowFeedback, hostID: string, sourceID: string) {
    this.expireFollow();
    if (!feedback.connected || !this.matchesFollow(feedback, hostID, sourceID)) return;
    this.acknowledgedFrame = { feedback, hostID, sourceID };
    await this.postFollowFeedback(feedback, hostID, sourceID);
  }
  async disconnectFollowDisplay() {
    const acknowledged = this.acknowledgedFrame; this.acknowledgedFrame = null;
    if (acknowledged) await this.postFollowFeedback({ ...acknowledged.feedback, connected: false }, acknowledged.hostID, acknowledged.sourceID);
  }
  private matchesFollow(feedback: FollowFeedback, hostID: string, sourceID: string) {
    const session = this.state.follow;
    return session && hostID === session.hostID && sourceID === session.sourceID && feedback.revision === session.revision && feedback.provider === session.state.provider && feedback.chatID === session.state.chatID && feedback.view === session.state.view;
  }
  private async postFollowFeedback(feedback: FollowFeedback, hostID: string, sourceID: string) {
    const session = this.state.follow; const host = this.host;
    if (!host || !session || !this.api.followFeedback || !this.matchesFollow(feedback, hostID, sourceID)) return;
    const key = `${this.followEpoch}:${hostID}:${sourceID}:${JSON.stringify(feedback)}`;
    if (key === this.lastFeedback || this.feedbackPending.has(key) && this.feedbackQueuedKey === key) return;
    this.lastFeedback = key; this.feedbackQueuedKey = key; this.feedbackPending.set(key, (this.feedbackPending.get(key) ?? 0) + 1);
    const api = this.api; const signal = feedback.connected ? this.followRequest.signal : new AbortController().signal;
    const run = async () => {
      try {
        if (feedback.connected && (!this.matchesFollow(feedback, hostID, sourceID) || signal.aborted)) return;
        await api.followFeedback!(host, feedback, signal);
      } catch { if (this.lastFeedback === key) this.lastFeedback = ''; }
      finally { const remaining = (this.feedbackPending.get(key) ?? 1) - 1; if (remaining) this.feedbackPending.set(key, remaining); else this.feedbackPending.delete(key); }
    };
    this.feedbackQueue = this.feedbackQueue.then(run, run); await this.feedbackQueue;
    // Feedback is display-only. Never apply its response as controller state;
    // the next ordered poll obtains any page normalization without an ACK loop.
  }
  navigate(view: View) { if (this.manualControlsPaused) return; this.state.view = view; this.state.focus = 0; this.state.error = null; this.emit(); }
  focus(index: number, count: number) { if (this.manualControlsPaused) return; this.state.focus = Math.max(0, Math.min(count - 1, index)); this.emit(); }
  turn(delta: number, count: number) { this.focus(this.state.focus + delta, count); }
  turnPage(delta: number, total: number) { if (this.manualControlsPaused) return; this.state.page = Math.max(0, Math.min(Math.max(0, total - 1), this.state.page + delta)); this.emit(); }
  back() { this.navigate('slots'); }
  clearError() { this.state.error = null; this.emit(); }
  dispose() { this.invalidateFollow(); this.route++; this.connection.abort(); this.selection.abort(); this.state.follow = null; this.listeners.clear(); }
}
