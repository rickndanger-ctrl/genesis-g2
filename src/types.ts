export type Provider = 'codex' | 'claude';
export type Host = { id: string; name: string; baseURL: string; token: string };
export type Chat = { id: string; title: string };
export type Slot = { slot: number; label: string; chatID: string | null; kind: 'empty' | 'chat' | 'shortcut'; action?: string };
export type Availability = { id: Provider; label: string; available: boolean; canReadReply: boolean; reason?: string };
export type HostStatus = { host: { id: string; name: string }; providers: Availability[]; version: string };
export type Reply = { provider: Provider; chatID: string; title: string; text: string; revision: string; updatedAt: string | null; status: 'unknown' | 'working' | 'done' | 'idle'; truncated: boolean; phase?: 'final_answer' | 'partial_answer' | 'commentary' | 'unknown' };
export type OpenResult = { ok: true; chat: Chat; status: 'requested' | 'confirmed' };
export type DisplayState = {
  provider: Provider; chatID: string | null; slotIndex: number | null;
  view: 'home' | 'reply' | 'draft'; page: number; draft: string; recording: boolean;
  sendState: 'none' | 'queued' | 'confirmed' | 'uncertain' | 'failed'; refreshNonce: number;
};
export type FollowFeedback = { revision: number; provider: Provider; chatID: string | null; view: DisplayState['view']; pageCount: number; renderedPage: number; connected: boolean };
export type FollowSession = {
  version: 1; hostID: string; active: true; revision: number; sourceID: string;
  sourceName: 'iPhone' | 'iPad'; expiresAt: string; chatTitle?: string; state: DisplayState;
  feedback?: Pick<FollowFeedback, 'revision' | 'pageCount' | 'renderedPage' | 'connected'>;
};
export type FollowSnapshot = FollowSession | { version: 1; hostID: string; active: false; revision: number; supported?: boolean };
export interface Gateway {
  status(host: Host, signal: AbortSignal): Promise<HostStatus>;
  profile(host: Host, provider: Provider, signal: AbortSignal): Promise<{ provider: Provider; slots: Slot[] }>;
  chats(host: Host, provider: Provider, signal: AbortSignal): Promise<{ provider: Provider; chats: Chat[] }>;
  open(host: Host, provider: Provider, chat: Chat, slot: number | undefined, signal: AbortSignal): Promise<OpenResult>;
  reply(host: Host, provider: Provider, chatID: string, signal: AbortSignal): Promise<Reply>;
  follow?(host: Host, signal: AbortSignal): Promise<FollowSnapshot>;
  followFeedback?(host: Host, feedback: FollowFeedback, signal: AbortSignal): Promise<FollowSnapshot>;
}
export const SLOT_COLORS = ['#4285ff', '#9965ed', '#ed66ad', '#f29b43', '#55b96d', '#50bfd7'] as const;
export const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude';
export const slotName = (provider: Provider, slot: number) => `${provider === 'codex' ? 'A' : 'C'}${slot}`;
