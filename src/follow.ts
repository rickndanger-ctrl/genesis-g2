import { composerPages, replyConversation, replyPages, shortLine, visibleWidth } from './pagination';
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
  const exactReply = state.reply?.provider === display.provider && state.reply.chatID === display.chatID ? state.reply : null;
  const history = replyConversation(exactReply);
  let conversation = history.pages;
  let ready = true;
  if (display.view === 'home') conversation = ['Choose a chat in Genesis.\n\nYour conversation stays above.\nYour draft stays in the composer.'];
  else if (display.provider === 'claude') conversation = ['Claude reply reading is not\nconnected yet.\n\nYour current draft appears below.\nTalk and Send stay in Genesis.'];
  else if (!exactReply && state.error) { conversation = replyPages(state.error, 42, 5); ready = false; }
  else if (!exactReply) { conversation = ['Loading this conversation…']; ready = false; }
  const draftPages = composerPages(display.draft, display.recording, display.sendState, follow.sourceName);
  const reviewingDraft = display.view === 'draft';
  // Reply controls page history; Draft controls page the complete composer.
  // Both panes stay visible, and page zero is always the most recent content.
  const pages = reviewingDraft ? draftPages : conversation;
  const page = Math.max(0, Math.min(display.page, pages.length - 1));
  const conversationPage = reviewingDraft ? 0 : page;
  const composerPage = reviewingDraft ? page : 0;
  const receipt = sendReceiptLabel(display.sendState);
  const status = display.recording ? 'Voice input' : receipt || (exactReply?.status === 'working' ? 'Working' : display.draft.trim() ? 'Draft, not sent' : '');
  const label = reviewingDraft ? 'Draft review' : display.view === 'home' ? 'Home' : history.replyOnly ? 'Latest reply only' : 'Recent conversation';
  const paneLabel = reviewingDraft ? 'Draft' : history.replyOnly && exactReply ? 'Reply only' : history.truncated ? 'Recent excerpt' : 'Conversation';
  const pageLabel = `${paneLabel} · ${page === 0 ? 'Latest' : 'Older'} ${page + 1}/${pages.length}`;
  const footerPane = reviewingDraft ? 'Draft' : display.view === 'home' ? 'Home' : history.replyOnly && exactReply ? 'Reply only' : history.truncated ? 'Excerpt' : 'Chat';
  const footerPage = `${page + 1}/${pages.length}`;
  let footer = [status, `${footerPane} ${page === 0 ? 'Latest' : 'Older'} ${footerPage}`].filter(Boolean).join(' · ');
  // Keep receipt meaning intact; very large page counts can omit Latest/Older.
  if (visibleWidth(footer) > 42) footer = [status, `${footerPane} ${footerPage}`].filter(Boolean).join(' · ');
  const feedback: FollowFeedback | undefined = ready || reviewingDraft ? { revision: follow.revision, provider: display.provider, chatID: display.chatID, view: display.view, pageCount: pages.length, renderedPage: page, connected: true } : undefined;
  return {
    title: display.view === 'home' ? `${providerName(display.provider)} / ${follow.sourceName}` : `${providerName(display.provider)} / ${slot}${state.selected?.title ?? follow.chatTitle ?? 'Selected chat'}`,
    pages, page, content: conversation[conversationPage], composer: draftPages[composerPage], label, receipt, status, pageLabel,
    footer: shortLine(footer, 42),
    context: `follow-conversation:${state.hostID}:${follow.hostID}:${follow.sourceID}:${display.provider}:${display.chatID ?? ''}:${display.view}:${display.refreshNonce}`,
    feedback: feedback ? { payload: feedback, hostID: follow.hostID, sourceID: follow.sourceID } : undefined,
    truncated: history.truncated,
    replyOnly: history.replyOnly && display.provider === 'codex' && Boolean(exactReply),
  };
}
