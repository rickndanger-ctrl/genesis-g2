import { replyPages, textPages } from './pagination';
import type { State } from './store';
import type { DisplayState, FollowFeedback } from './types';
import { providerName, slotName } from './types';

export const sendReceiptLabel = (state: DisplayState['sendState']) => ({ none: '', queued: 'Send queued', confirmed: 'Sent', uncertain: 'Send unverified', failed: 'Send failed' })[state];

/** One presentation feeds both the phone preview and the acknowledged G2 frame. */
export function followPresentation(state: State) {
  const follow = state.follow;
  if (!follow) return null;
  const display = follow.state;
  const slot = display.slotIndex === null ? '' : `${slotName(display.provider, display.slotIndex + 1)} / `;
  let content: string;
  let ready = true;
  if (display.view === 'home') content = `Following ${follow.sourceName}\n\nChoose a chat in Genesis.\nUse its Talk and Send controls.\nReplies and drafts appear here.`;
  else if (display.view === 'draft') content = display.draft || (display.recording ? 'Listening… Your words appear here.' : 'Your draft will appear here.');
  else if (display.provider === 'claude') content = 'Claude reply reading is not connected yet.\n\nChat switching, dictation and Send stay in the native Genesis app. Your draft can be shown here.';
  else if (state.error) { content = state.error; ready = false; }
  else if (state.reply?.provider === display.provider && state.reply.chatID === display.chatID) content = state.reply.text;
  else { content = 'Loading this chat’s reply…'; ready = false; }
  const allPages = display.view === 'draft' ? textPages(content) : replyPages(content);
  const pages = allPages.slice(0, 1000);
  const page = Math.max(0, Math.min(display.page, pages.length - 1));
  const label = display.view === 'draft' ? display.recording ? 'Recording' : 'Draft' : display.view === 'home' ? 'Home' : 'Reply';
  const receipt = sendReceiptLabel(display.sendState);
  const feedback: FollowFeedback | undefined = ready ? { revision: follow.revision, provider: display.provider, chatID: display.chatID, view: display.view, pageCount: pages.length, renderedPage: page, connected: true } : undefined;
  return {
    title: display.view === 'home' ? `${providerName(display.provider)} / ${follow.sourceName}` : `${providerName(display.provider)} / ${slot}${state.selected?.title ?? follow.chatTitle ?? 'Selected chat'}`,
    pages, page, content: pages[page], label, receipt,
    footer: `${label} ${page + 1}/${pages.length}${display.recording && display.view !== 'draft' ? ' / Recording' : ''}${receipt ? ` / ${receipt}` : ''} / ${follow.sourceName}`,
    context: `follow:${state.hostID}:${follow.hostID}:${follow.sourceID}:${display.provider}:${display.chatID ?? ''}:${display.view}:${display.refreshNonce}`,
    feedback: feedback ? { payload: feedback, hostID: follow.hostID, sourceID: follow.sourceID } : undefined,
    truncated: allPages.length > 1000 || (display.view === 'reply' && state.reply?.truncated === true),
  };
}
