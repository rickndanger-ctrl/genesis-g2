import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// A local read-only adapter. No subprocess, network, UI action or agent SDK
// query/resume call belongs here. The caller still authorizes the mapped chat.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CHAT_ID = /^claude-[a-f0-9]{32}$/;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_TOTAL = 16 * 1024 * 1024;
const MAX_SESSIONS = 512;
const MAX_IDENTITY_PINS = 512;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 6;
const MAX_MESSAGE_SCALARS = 8000;
const MAX_SCALARS = 16000;
const CHAIN_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);
const GENERIC_MESSAGE = 'This exact Claude Code conversation could not be read. No conversation was opened or changed.';

export class ClaudeReaderError extends Error {
  constructor(code) { super(GENERIC_MESSAGE); this.name = 'ClaudeReaderError'; this.code = code; }
}
function fail(code) { throw new ClaudeReaderError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function uuid(value) { return typeof value === 'string' && UUID.test(value); }
export function claudeChatID(title) { return 'claude-' + createHash('sha256').update(title, 'utf8').digest('hex').slice(0, 32); }
function validateTarget(target) {
  if (!object(target) || typeof target.id !== 'string' || !CHAT_ID.test(target.id)
      || typeof target.title !== 'string' || !target.title.length || target.title.length > 2000
      || target.title.includes('\0') || claudeChatID(target.title) !== target.id) fail('invalid_target');
}
function contained(home, path) {
  const rel = relative(home, path);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) fail('unsafe_path');
  return rel;
}
async function checkedPath(home, path, directory = false) {
  const parts = contained(home, path).split(sep);
  let cursor = home, result;
  for (const part of parts) {
    cursor = join(cursor, part); result = await lstat(cursor);
    if (result.isSymbolicLink() || (process.getuid && result.uid !== process.getuid())) fail('unsafe_path');
    if (cursor !== path && !result.isDirectory()) fail('unsafe_path');
  }
  if (directory ? !result.isDirectory() : !result.isFile()) fail('unsafe_path');
  if (await realpath(path) !== path) fail('unsafe_path');
  return result;
}
async function readJSON(home, path, budget) {
  const before = await checkedPath(home, path);
  if (!before.size || before.size > MAX_METADATA_BYTES) fail('invalid_metadata');
  budget.remaining -= before.size;
  if (budget.remaining < 0) fail('inventory_limit');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const start = await file.stat();
    if (start.dev !== before.dev || start.ino !== before.ino || start.size !== before.size) fail('identity_changed');
    const buffer = Buffer.alloc(start.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) fail('invalid_metadata');
      offset += bytesRead;
    }
    const end = await file.stat();
    if (end.size !== start.size || end.mtimeMs !== start.mtimeMs) fail('identity_changed');
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    if (!object(result)) fail('invalid_metadata');
    return result;
  } finally { await file.close(); }
}

async function resolveBinding(home, target) {
  const app = join(home, 'Library', 'Application Support', 'Claude');
  const budget = { remaining: MAX_METADATA_TOTAL };
  const desktop = await readJSON(home, join(app, 'config.json'), budget);
  const cli = await readJSON(home, join(home, '.claude.json'), budget);
  const account = cli.oauthAccount;
  if (!object(account) || !uuid(account.accountUuid) || !uuid(account.organizationUuid)
      || desktop.lastKnownAccountUuid !== account.accountUuid) fail('account_mismatch');
  const directory = join(app, 'claude-code-sessions', account.accountUuid, account.organizationUuid);
  await checkedPath(home, directory, true);
  const names = (await readdir(directory)).filter(name => /^local_[a-f0-9-]+\.json$/.test(name));
  if (names.length > MAX_SESSIONS) fail('inventory_limit');
  const matches = [];
  for (const name of names) {
    const filenameID = name.slice(6, -5);
    if (!uuid(filenameID)) continue;
    const record = await readJSON(home, join(directory, name), budget);
    if (record.title !== target.title || record.isArchived === true) continue;
    // Missing archive status cannot establish an active Desktop session.
    if (record.isArchived !== false || record.sessionId !== 'local_' + filenameID || !uuid(record.cliSessionId)
        || typeof record.cwd !== 'string' || !isAbsolute(record.cwd) || record.cwd.includes('\0')
        || record.cwd.length > 4096 || resolve(record.cwd) !== record.cwd) fail('invalid_metadata');
    matches.push({ record, filenameID });
  }
  if (matches.length !== 1) fail(matches.length ? 'ambiguous_session' : 'session_unavailable');
  const { record, filenameID } = matches[0];
  // This is Claude Code's local project encoding. Never search by title or
  // newest transcript when this exact indexed UUID path is unavailable.
  const project = record.cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const transcript = join(home, '.claude', 'projects', project, record.cliSessionId + '.jsonl');
  const stat = await checkedPath(home, transcript);
  return { accountID: account.accountUuid, organizationID: account.organizationUuid,
    desktopSessionID: filenameID, cliSessionID: record.cliSessionId, cwd: record.cwd,
    title: record.title, transcript, stat };
}
export function sameBinding(a, b) {
  return ['accountID', 'organizationID', 'desktopSessionID', 'cliSessionID', 'cwd', 'title', 'transcript']
    .every(key => a[key] === b[key]) && a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino;
}
function pinnedIdentity(binding) {
  return JSON.stringify(['accountID', 'organizationID', 'desktopSessionID', 'cliSessionID', 'cwd']
    .map(key => binding[key]));
}

async function readTail(home, binding, maximum) {
  const before = await checkedPath(home, binding.transcript);
  if (before.dev !== binding.stat.dev || before.ino !== binding.stat.ino) fail('identity_changed');
  const file = await open(binding.transcript, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size < before.size) fail('identity_changed');
    const start = Math.max(0, stat.size - maximum), buffer = Buffer.alloc(stat.size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, start + offset);
      if (!bytesRead) fail('identity_changed');
      offset += bytesRead;
    }
    const end = await file.stat();
    if (end.size < stat.size || (end.size === stat.size && end.mtimeMs !== stat.mtimeMs)) fail('identity_changed');
    return { buffer, startsMidFile: start > 0 };
  } finally { await file.close(); }
}
function cleanText(raw) {
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
function isUserScaffolding(text) {
  return ['<system-reminder>', '<task-notification>', '<local-command-caveat>', '<local-command-stdout>',
    '<local-command-stderr>', '<command-message>', '<command-name>', '<ide_opened_file>', '<ide_selection>',
    'This session is being continued from a previous conversation that ran out of context.',
    'Caveat: The messages below were generated by the user while running local commands.']
    .some(prefix => text.startsWith(prefix));
}
function visibleMessage(record) {
  if (!['user', 'assistant'].includes(record.type) || record.isSidechain !== false
      || record.isMeta === true || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true
      || record.hidden === true || record.visibility === 'hidden' || record.toolUseResult !== undefined
      || record.sourceToolAssistantUUID !== undefined || !object(record.message)
      || record.message.role !== record.type) return null;
  const content = record.message.content;
  let text;
  if (typeof content === 'string' && record.type === 'user') text = content;
  else if (Array.isArray(content)) {
    if (record.type === 'user' && content.some(block => object(block) && ['tool_result', 'tool_use'].includes(block.type))) return null;
    text = content.filter(block => object(block) && block.type === 'text' && typeof block.text === 'string'
      && block.hidden !== true && block.visibility !== 'hidden'
      && (record.type !== 'user' || !isUserScaffolding(cleanText(block.text)))).map(block => block.text).join('\n');
  } else return null;
  text = cleanText(text);
  if (!text || (record.type === 'user' && isUserScaffolding(text))) return null;
  const phase = record.message.stop_reason === 'end_turn' ? 'final_answer'
    : record.message.stop_reason === 'tool_use' ? 'commentary' : 'unknown';
  return { role: record.type, text, ...(record.type === 'assistant' ? { phase } : {}) };
}
function boundMessages(newestFirst) {
  const required = ['user', 'assistant'].map(role => newestFirst.findIndex(message => message.role === role)).filter(i => i >= 0);
  const chosen = new Set(required);
  for (let i = 0; i < newestFirst.length && chosen.size < MAX_MESSAGES; i++) chosen.add(i);
  let remaining = MAX_SCALARS;
  const output = new Map();
  for (const index of [...required, ...[...chosen].sort((a, b) => a - b).filter(i => !required.includes(i))]) {
    if (!remaining) continue;
    const source = newestFirst[index], scalars = Array.from(source.text), limit = Math.min(remaining, MAX_MESSAGE_SCALARS);
    const text = scalars.slice(0, limit).join(''); remaining -= Math.min(scalars.length, limit);
    output.set(index, { ...source, text, truncated: scalars.length > limit });
  }
  const turns = [...output].sort(([a], [b]) => b - a).map(([, message]) => message);
  return { turns, clipped: output.size < newestFirst.length || turns.some(message => message.truncated) };
}

export function parseClaudeTail(buffer, binding, { startsMidFile = false } = {}) {
  let begin = 0, end = buffer.length, limited = startsMidFile;
  if (startsMidFile) { const newline = buffer.indexOf(10); if (newline < 0) fail('history_unavailable'); begin = newline + 1; }
  if (end && buffer[end - 1] !== 10) { end = buffer.lastIndexOf(10) + 1; limited = true; }
  const nodes = new Map(); let leaf = null, bridge = null;
  for (let cursor = begin; cursor < end;) {
    const newline = buffer.indexOf(10, cursor), stop = newline < 0 ? end : newline;
    const line = buffer.subarray(cursor, stop); cursor = stop + 1;
    if (!line.length) continue;
    if (line.length > MAX_LINE_BYTES) { limited = true; continue; }
    let record;
    try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { fail('invalid_transcript'); }
    if (!object(record) || record.sessionId !== binding.cliSessionID) continue;
    if (record.type === 'bridge-session') { bridge = record; continue; }
    if (!CHAIN_TYPES.has(record.type) || record.isSidechain !== false || !uuid(record.uuid)) continue;
    if (record.parentUuid !== null && !uuid(record.parentUuid)) fail('invalid_transcript');
    if (nodes.has(record.uuid)) fail('ambiguous_history');
    nodes.set(record.uuid, record); leaf = record.uuid;
  }
  if (!bridge || bridge.ownerAccountUuid !== binding.accountID || bridge.ownerOrganizationUuid !== binding.organizationID) fail('transcript_owner_unverified');
  const messages = [], seen = new Set(); let cursor = leaf;
  while (cursor) {
    if (seen.has(cursor)) fail('ambiguous_history');
    seen.add(cursor);
    const record = nodes.get(cursor);
    if (!record) { limited = true; break; }
    const message = visibleMessage(record); if (message) messages.push(message);
    cursor = record.parentUuid;
  }
  const { turns, clipped } = boundMessages(messages);
  const lastAssistant = [...turns].reverse().find(message => message.role === 'assistant');
  return { reply: lastAssistant ? { text: lastAssistant.text, phase: lastAssistant.phase, truncated: lastAssistant.truncated } : null,
    turns, turnsTruncated: limited || clipped, limited };
}

export function createClaudeReader(config = {}) {
  const configuredHome = resolve(config.home ?? homedir());
  const maximum = config.maxTailBytes ?? MAX_TAIL_BYTES;
  const pins = new Map();
  if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > MAX_TAIL_BYTES) fail('invalid_configuration');
  function checkPin(id, binding) {
    const pin = pins.get(id), identity = pinnedIdentity(binding);
    if (pin !== undefined && pin !== identity) fail('identity_changed');
    if (pin === undefined && pins.size >= MAX_IDENTITY_PINS) fail('inventory_limit');
    return identity;
  }
  return async function readClaudeReply(target) {
    try {
      validateTarget(target);
      const home = await realpath(configuredHome);
      const homeStat = await lstat(home);
      if (!homeStat.isDirectory() || (process.getuid && homeStat.uid !== process.getuid())) fail('unsafe_path');
      const before = await resolveBinding(home, target);
      checkPin(target.id, before);
      const tail = await readTail(home, before, maximum);
      const result = parseClaudeTail(tail.buffer, before, { startsMidFile: tail.startsMidFile });
      const after = await resolveBinding(home, target);
      if (!sameBinding(before, after)) fail('identity_changed');
      // Recheck after await: concurrent first reads cannot race a rebind.
      pins.set(target.id, checkPin(target.id, after));
      return { ok: true, provider: 'claude', threadId: target.id, title: target.title, state: 'unknown', ...result };
    } catch (error) {
      if (error instanceof ClaudeReaderError) throw error;
      // JSON, filesystem and decoding errors can contain private paths/text.
      throw new ClaudeReaderError('reader_unavailable');
    }
  };
}
