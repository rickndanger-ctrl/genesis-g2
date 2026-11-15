import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeReaderError, claudeChatID, createClaudeReader, parseClaudeTail, sameBinding } from './reader.mjs';

const ID = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const accountID = ID(1), organizationID = ID(2), desktopSessionID = ID(3), cliSessionID = ID(4);
const binding = { accountID, organizationID, cliSessionID };
const target = { title: 'Fixture chat', id: claudeChatID('Fixture chat') };
const bridge = { type: 'bridge-session', sessionId: cliSessionID, bridgeSessionId: ID(5), ownerAccountUuid: accountID, ownerOrganizationUuid: organizationID };
const record = (role, number, parent, text, extra = {}) => ({ type: role, uuid: ID(number), parentUuid: parent === null ? null : ID(parent),
  sessionId: cliSessionID, isSidechain: false, message: { role, content: role === 'user' ? text : [{ type: 'text', text }], stop_reason: role === 'assistant' ? 'end_turn' : undefined }, ...extra });
const bytes = (...rows) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
function parse(...rows) { return parseClaudeTail(bytes(bridge, ...rows), binding); }
function failure(code, fn) { assert.throws(fn, error => error instanceof ClaudeReaderError && error.code === code); }
async function fixture(t, rows = [record('user', 10, null, 'Question'), record('assistant', 11, 10, 'Answer')]) {
  const home = await mkdtemp(join(tmpdir(), 'genesis-claude-reader-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const app = join(home, 'Library', 'Application Support', 'Claude');
  const index = join(app, 'claude-code-sessions', accountID, organizationID);
  const cwd = '/fixture/project';
  const transcript = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), cliSessionID + '.jsonl');
  await mkdir(index, { recursive: true }); await mkdir(join(transcript, '..'), { recursive: true });
  await writeFile(join(app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: accountID }));
  await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: accountID, organizationUuid: organizationID } }));
  const metadata = { sessionId: 'local_' + desktopSessionID, cliSessionId: cliSessionID, cwd, originCwd: cwd, isArchived: false, title: target.title, bridgeSessionIds: [ID(5)] };
  const file = join(index, 'local_' + desktopSessionID + '.json');
  await writeFile(file, JSON.stringify(metadata)); await writeFile(transcript, bytes(bridge, ...rows));
  return { home, app, index, file, metadata, transcript, read: createClaudeReader({ home }) };
}

test('exact current-account Desktop index resolves a real user/assistant conversation', async t => {
  const f = await fixture(t), before = await readFile(f.transcript);
  const result = await f.read(target);
  assert.deepEqual(result.turns.map(turn => [turn.role, turn.text]), [['user', 'Question'], ['assistant', 'Answer']]);
  assert.equal(result.threadId, target.id); assert.equal(result.provider, 'claude'); assert.equal(result.state, 'unknown');
  assert.equal(result.reply.phase, 'final_answer'); assert.equal(result.turnsTruncated, false);
  assert.deepEqual(await readFile(f.transcript), before);
});
test('title hash is exact UTF-8 without trim or normalization', async t => {
  assert.notEqual(claudeChatID('e\u0301'), claudeChatID('\u00e9'));
  assert.notEqual(claudeChatID('Title'), claudeChatID('Title '));
  const f = await fixture(t);
  await assert.rejects(f.read({ ...target, title: 'Wrong' }), { code: 'invalid_target' });
});
test('same-title transcript outside exact indexed CLI UUID is never read', async t => {
  const f = await fixture(t);
  await writeFile(join(f.transcript, '..', ID(40) + '.jsonl'), bytes({ type: 'custom-title', customTitle: target.title, sessionId: ID(40) }, record('assistant', 41, null, 'Wrong fork')));
  assert.equal((await f.read(target)).reply.text, 'Answer');
});
test('multiple active Desktop titles fail closed; archived duplicate is excluded', async t => {
  const f = await fixture(t), other = join(f.index, 'local_' + ID(20) + '.json');
  await writeFile(other, JSON.stringify({ ...f.metadata, sessionId: 'local_' + ID(20) }));
  await assert.rejects(f.read(target), { code: 'ambiguous_session' });
  await writeFile(other, JSON.stringify({ ...f.metadata, sessionId: 'local_' + ID(20), isArchived: true }));
  assert.equal((await f.read(target)).reply.text, 'Answer');
});
test('unsupported web/missing chat has no title or newest-file fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(f.read({ id: claudeChatID('Web chat'), title: 'Web chat' }), { code: 'session_unavailable' });
});
test('desktop and local CLI accounts must agree', async t => {
  const f = await fixture(t);
  await writeFile(join(f.app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: ID(99) }));
  await assert.rejects(f.read(target), { code: 'account_mismatch' });
});
test('metadata filename, UUID, archive state and cwd are validated', async t => {
  const f = await fixture(t);
  for (const delta of [{ sessionId: ID(99) }, { sessionId: desktopSessionID }, { cliSessionId: '../private' }, { isArchived: null }, { cwd: '/fixture/../other' }]) {
    await writeFile(f.file, JSON.stringify({ ...f.metadata, ...delta }));
    await assert.rejects(f.read(target), { code: 'invalid_metadata' });
  }
});
test('public title IDs cannot silently bind to another account between successful polls', async t => {
  const f = await fixture(t); await f.read(target);
  const otherAccount = ID(80), otherOrg = ID(81), index = join(f.app, 'claude-code-sessions', otherAccount, otherOrg);
  await mkdir(index, { recursive: true }); await writeFile(join(index, 'local_' + desktopSessionID + '.json'), JSON.stringify(f.metadata));
  await writeFile(join(f.app, 'config.json'), JSON.stringify({ lastKnownAccountUuid: otherAccount }));
  await writeFile(join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: otherAccount, organizationUuid: otherOrg } }));
  await writeFile(f.transcript, bytes({ ...bridge, ownerAccountUuid: otherAccount, ownerOrganizationUuid: otherOrg }, record('assistant', 20, null, 'Other account')));
  await assert.rejects(f.read(target), { code: 'identity_changed' });
});
test('same-title session remap between polls requires a fresh reader, while same-session file rotation works', async t => {
  const f = await fixture(t); await f.read(target);
  const content = await readFile(f.transcript); await rm(f.transcript); await writeFile(f.transcript, content);
  assert.equal((await f.read(target)).reply.text, 'Answer');
  await rm(f.file); await writeFile(join(f.index, 'local_' + ID(90) + '.json'), JSON.stringify({ ...f.metadata, sessionId: 'local_' + ID(90) }));
  await assert.rejects(f.read(target), { code: 'identity_changed' });
  assert.equal((await createClaudeReader({ home: f.home })(target)).reply.text, 'Answer');
});
test('aggregate metadata budget bounds a large otherwise-valid index', async t => {
  const f = await fixture(t);
  for (let i = 100; i < 109; i++) await writeFile(join(f.index, 'local_' + ID(i) + '.json'), JSON.stringify({ ...f.metadata, title: 'Unrelated', sessionId: 'local_' + ID(i), padding: 'x'.repeat(2 * 1024 * 1024 - 2000) }));
  await assert.rejects(f.read(target), { code: 'inventory_limit' });
});
test('metadata and transcript symlinks are rejected', async t => {
  const f = await fixture(t), copy = join(f.home, 'copy.jsonl');
  await writeFile(copy, await readFile(f.transcript)); await rm(f.transcript); await symlink(copy, f.transcript);
  await assert.rejects(f.read(target), { code: 'unsafe_path' });
});
test('sanitized errors never expose malformed metadata or private paths', async t => {
  const f = await fixture(t); await writeFile(f.file, '{"private content":');
  await assert.rejects(f.read(target), error => error instanceof ClaudeReaderError && !String(error).includes(f.home) && !String(error).includes('private content'));
});
test('recheck compares identity, not normal metadata mtime or transcript growth', () => {
  const a = { ...binding, desktopSessionID, cwd: '/fixture', title: 'A', transcript: '/fixture/transcript', stat: { dev: 1, ino: 2, size: 3, mtimeMs: 1 } };
  assert.equal(sameBinding(a, { ...a, stat: { ...a.stat, size: 30, mtimeMs: 9 } }), true);
  for (const key of ['accountID', 'organizationID', 'desktopSessionID', 'cliSessionID', 'cwd', 'title', 'transcript']) assert.equal(sameBinding(a, { ...a, [key]: 'changed' }), false);
  assert.equal(sameBinding(a, { ...a, stat: { ...a.stat, ino: 99 } }), false);
});
test('only role-provenance text appears; tools, thinking, attachments and internal records stay private', () => {
  const rows = [record('user', 10, null, 'Real question')];
  rows.push(record('assistant', 11, 10, '', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private thought' }, { type: 'tool_use', name: 'Private tool', input: { text: 'Not visible' } }], stop_reason: 'tool_use' } }));
  rows.push(record('user', 12, 11, '', { message: { role: 'user', content: [{ type: 'tool_result', content: 'Private result' }, { type: 'text', text: 'Do not present tool context as user' }] } }));
  rows.push({ type: 'attachment', uuid: ID(13), parentUuid: ID(12), sessionId: cliSessionID, isSidechain: false, attachment: { text: 'Private attachment' } });
  rows.push(record('user', 14, 13, 'Private system text', { isMeta: true }));
  rows.push(record('assistant', 15, 14, 'Visible answer'));
  assert.deepEqual(parse(...rows).turns.map(turn => turn.text), ['Real question', 'Visible answer']);
});
test('explicit mismatched role, sidechains and foreign session messages are excluded', () => {
  const badRole = record('user', 11, 10, 'Wrong role'); badRole.message.role = 'system';
  const result = parse(record('user', 10, null, 'Real'), badRole, record('assistant', 12, 11, 'Answer'),
    record('assistant', 13, 12, 'Sidechain', { isSidechain: true }), record('assistant', 14, 12, 'Foreign', { sessionId: ID(99) }));
  assert.deepEqual(result.turns.map(turn => turn.text), ['Real', 'Answer']);
});
test('known generated user wrappers and compaction summaries are not human messages', () => {
  for (const text of ['<system-reminder>Private', '<task-notification>Private', '<local-command-stdout>Private', '<command-message>Private',
    'This session is being continued from a previous conversation that ran out of context. Private']) {
    assert.equal(parse(record('user', 10, null, text)).turns.length, 0);
  }
  assert.equal(parse(record('user', 10, null, 'Keep **my** literal Markdown.')).turns[0].text, 'Keep **my** literal Markdown.');
  const mixed = record('user', 10, null, '', { message: { role: 'user', content: [{ type: 'text', text: 'Human prompt' }, { type: 'text', text: '<system-reminder>Internal context' }] } });
  assert.equal(parse(mixed).turns[0].text, 'Human prompt');
});
test('actual parent chain excludes unrelated branches rather than guessing alternating roles', () => {
  const result = parse(record('user', 10, null, 'Question'), record('assistant', 11, 10, 'Abandoned branch'), record('assistant', 12, 10, 'Current branch'));
  assert.deepEqual(result.turns.map(turn => turn.text), ['Question', 'Current branch']);
});
test('missing parent truncates ancestry without jumping to unrelated roots', () => {
  const result = parse(record('user', 10, null, 'Unrelated old prompt'), record('assistant', 12, 99, 'Current tail'));
  assert.deepEqual(result.turns.map(turn => turn.text), ['Current tail']); assert.equal(result.turnsTruncated, true);
});
test('duplicate UUID and ancestry cycles fail closed', () => {
  failure('ambiguous_history', () => parse(record('user', 10, null, 'A'), record('user', 10, null, 'B')));
  failure('ambiguous_history', () => parse(record('user', 10, 11, 'A'), record('assistant', 11, 10, 'B')));
});
test('latest transcript bridge owner must match current account and organization', () => {
  failure('transcript_owner_unverified', () => parseClaudeTail(bytes({ ...bridge, ownerAccountUuid: ID(99) }, record('user', 10, null, 'Private')), binding));
  failure('transcript_owner_unverified', () => parseClaudeTail(bytes(record('user', 10, null, 'Private')), binding));
});
test('tail alignment and unfinished append cannot leak partial records', () => {
  const buffer = Buffer.concat([Buffer.from('partial private line\n'), bytes(bridge, record('user', 10, null, 'Complete question')), Buffer.from('{"type":"assistant","private":"unfinished')]);
  const result = parseClaudeTail(buffer, binding, { startsMidFile: true });
  assert.deepEqual(result.turns.map(turn => turn.text), ['Complete question']); assert.equal(result.limited, true);
});
test('bounded excerpt retains newest user among long commentary sequences', () => {
  const rows = [record('user', 10, null, 'Newest human request')];
  for (let i = 11; i < 30; i++) rows.push(record('assistant', i, i - 1, 'Progress ' + i, { message: { role: 'assistant', content: [{ type: 'text', text: 'Progress ' + i }], stop_reason: 'tool_use' } }));
  const result = parse(...rows);
  assert.equal(result.turns.length, 6); assert.equal(result.turns[0].text, 'Newest human request');
  assert.equal(result.turns.at(-1).text, 'Progress 29'); assert.equal(result.reply.phase, 'commentary'); assert.equal(result.turnsTruncated, true);
});
test('Unicode scalar budget reserves newest user and assistant text', () => {
  const result = parse(record('user', 10, null, 'e\u0301'.repeat(9000)), record('assistant', 11, 10, '🙂'.repeat(9000)));
  assert.deepEqual(result.turns.map(turn => Array.from(turn.text).length), [8000, 8000]);
  assert.equal(result.turns.every(turn => turn.truncated), true);
});
test('new unanswered user does not relabel an older reply as current completion', () => {
  const result = parse(record('user', 10, null, 'Earlier'), record('assistant', 11, 10, 'Old final'), record('user', 12, 11, 'New question'));
  assert.equal(result.turns.at(-1).role, 'user'); assert.equal(result.reply.text, 'Old final');
});
test('tail read is bounded and labels omitted history', async t => {
  const f = await fixture(t, []);
  await writeFile(f.transcript, Buffer.concat([Buffer.from(' '.repeat(3000) + '\n'), bytes(bridge, record('user', 10, 99, 'Recent'))]));
  const result = await createClaudeReader({ home: f.home, maxTailBytes: 1024 })(target);
  assert.equal(result.turns[0].text, 'Recent'); assert.equal(result.turnsTruncated, true);
});
