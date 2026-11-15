import type { ConversationTurn, Provider, Reply } from './types';

// Glasses use one firmware font. Keep pages intentionally sparse, within both
// text-byte limits and a conservative visible line budget.
export function plainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/```[^\n]*\n?/g, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/\t/g, '  ').trim();
}
export function truncateUTF8(text: string, max: number): string {
  const encoder = new TextEncoder(); let result = ''; let bytes = 0;
  for (const char of text) { const size = encoder.encode(char).length; if (bytes + size > max) break; bytes += size; result += char; }
  return result;
}
export function replyPages(text: string, width = 42, rows = 7): string[] {
  const clean = plainText(text);
  if (!clean) return ['No assistant reply is available yet.'];
  return textPages(clean, width, rows);
}
// Drafts are user-authored text: do not strip Markdown or change their content.
export function textPages(text: string, width = 42, rows = 7): string[] {
  const clean = text.replace(/\r\n?/g, '\n');
  if (!clean.trim()) return ['Your draft will appear here.'];
  const lines = textLines(clean, width);
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows).join('\n'));
  return pages;
}
export const visibleWidth = (value: string) => Array.from(value).reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
export function shortLine(text: string, width: number): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  if (visibleWidth(line) <= width) return line;
  let result = '';
  for (const char of line) { if (visibleWidth(result + char) > width - 1) break; result += char; }
  return result.trimEnd() + '…';
}
export function textLines(text: string, width = 42): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    const size = visibleWidth;
    for (const word of paragraph.trim().split(/\s+/u)) {
      const chars = Array.from(word);
      if (size(line) + size(word) + (line ? 1 : 0) <= width) { line += (line ? ' ' : '') + word; continue; }
      if (line) { lines.push(line); line = ''; }
      while (size(chars.join('')) > width) {
        let fragment = ''; let used = 0;
        while (chars.length && used + size(chars[0]) <= width) { const char = chars.shift()!; fragment += char; used += size(char); }
        lines.push(fragment);
      }
      line = chars.join('');
    }
    if (line) lines.push(line);
  }
  return lines;
}

// Newest page first, while each page preserves the conversation's reading order.
// Role labels repeat at page boundaries so a long answer never becomes anonymous.
export function conversationPages(turns: ConversationTurn[], width = 42, rows = 5, provider: Provider = 'codex'): string[] {
  const assistantPrefix = provider === 'claude' ? 'CLAUDE: ' : 'CODEX: ';
  const entries = turns.flatMap((turn, turnIndex) => textLines(turn.role === 'assistant' ? plainText(turn.text) : turn.text, width - assistantPrefix.length).map(text => ({ turnIndex, role: turn.role, text })));
  if (!entries.length) return ['No conversation text is available yet.'];
  let lastUserIndex = -1; turns.forEach((turn, index) => { if (turn.role === 'user' && turn.text.trim()) lastUserIndex = index; });
  const pinPrompt = lastUserIndex >= 0 && !entries.slice(-rows).some(entry => entry.turnIndex === lastUserIndex);
  const pages: string[] = []; let end = entries.length;
  while (end > 0) {
    const pin = pages.length === 0 && pinPrompt;
    const start = Math.max(0, end - rows + (pin ? 1 : 0)); const chunk = entries.slice(start, end);
    const lines = chunk.map((entry, index) => `${index === 0 || chunk[index - 1].turnIndex !== entry.turnIndex ? entry.role === 'user' ? 'YOU: ' : assistantPrefix : '  '}${entry.text}`);
    if (pin) lines.unshift(`YOU: ${shortLine(turns[lastUserIndex].text, width - 5)}`);
    pages.push(lines.join('\n')); end = start;
  }
  return pages;
}
export function replyConversation(reply: Reply | null) {
  const turns = reply?.turns?.filter(turn => turn.text.trim());
  const hasHistory = Boolean(turns?.length);
  const pages = hasHistory ? conversationPages(turns!, 42, 5, reply!.provider) : reply?.text.trim() ? conversationPages([{ role: 'assistant', text: reply.text, phase: reply.phase }], 42, 5, reply.provider) : ['No conversation text is available yet.'];
  return { pages: pages.slice(0, 1000), replyOnly: !hasHistory, truncated: pages.length > 1000 || reply?.turnsTruncated === true || reply?.truncated === true || turns?.some(turn => turn.truncated) === true };
}
export function composerText(draft: string, voiceInput: boolean, sendState: string, sourceName: string): string {
  return composerPages(draft, voiceInput, sendState, sourceName)[0];
}
export function composerPages(draft: string, voiceInput: boolean, sendState: string, sourceName: string): string[] {
  if (draft.trim()) {
    // Review every word in the small composer. Normalize whitespace only for
    // display so many explicit line breaks cannot consume the 1000-page limit.
    const lines = textLines(draft.replace(/\s+/gu, ' ').trim(), 35); const pages: string[] = [];
    for (let end = lines.length; end > 0; end -= 2) pages.push(lines.slice(Math.max(0, end - 2), end).map((line, index) => `${index === 0 ? 'YOU > ' : '      '}${line}`).join('\n'));
    return pages;
  }
  if (voiceInput) return ['YOU > Voice input active\n      Speak using Genesis.'];
  if (sendState === 'queued') return ['YOU > Send queued\n      Awaiting confirmation.'];
  if (sendState === 'confirmed') return ['YOU > Message sent\n      Hold Talk for another prompt.'];
  if (sendState === 'uncertain') return ['YOU > Send not verified\n      Check Genesis before retrying.'];
  if (sendState === 'failed') return ['YOU > Send failed\n      Review your draft in Genesis.'];
  return [`YOU > Hold Talk or type on ${sourceName}\n      Review, then press Send.`];
}
