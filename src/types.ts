export type Provider = 'codex' | 'claude';
export type Host = { id: string; name: string; baseURL: string; token: string };
export type Chat = { id: string; title: string };
export type Slot = { slot: number; label: string; chatID: string | null; kind: 'empty' | 'chat' | 'shortcut'; action?: string };
export type Availability = { id: Provider; label: string; available: boolean; canReadReply: boolean; reason?: string };
export type HostStatus = { host: { id: string; name: string }; providers: Availability[]; version: string };
export type Reply = { provider: Provider; chatID: string; title: string; text: string; revision: string; updatedAt: string | null; status: 'unknown' | 'working' | 'done' | 'idle'; truncated: boolean; phase?: 'final_answer' | 'partial_answer' | 'commentary' | 'unknown' };
export type OpenResult = { ok: true; chat: Chat; status: 'requested' | 'confirmed' };
export interface Gateway {
  status(host: Host, signal: AbortSignal): Promise<HostStatus>;
  profile(host: Host, provider: Provider, signal: AbortSignal): Promise<{ provider: Provider; slots: Slot[] }>;
  chats(host: Host, provider: Provider, signal: AbortSignal): Promise<{ provider: Provider; chats: Chat[] }>;
  open(host: Host, provider: Provider, chat: Chat, slot: number | undefined, signal: AbortSignal): Promise<OpenResult>;
  reply(host: Host, provider: Provider, chatID: string, signal: AbortSignal): Promise<Reply>;
}
export const SLOT_COLORS = ['#4285ff', '#9965ed', '#ed66ad', '#f29b43', '#55b96d', '#50bfd7'] as const;
export const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude';
export const slotName = (provider: Provider, slot: number) => `${provider === 'codex' ? 'A' : 'C'}${slot}`;
