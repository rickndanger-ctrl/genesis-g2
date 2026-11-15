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
  const lines: string[] = [];
  for (const paragraph of clean.split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    const size = (value: string) => Array.from(value).reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
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
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows).join('\n'));
  return pages;
}
