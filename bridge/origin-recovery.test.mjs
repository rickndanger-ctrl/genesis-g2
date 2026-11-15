import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOriginRecovery, isRecoveryOrigin, OriginRecoveryError } from './origin-recovery.mjs';
import { createBridge } from './server.mjs';

const TOKEN = 'fixture-pairing-token-'.repeat(3);
const TTL = 90 * 24 * 60 * 60 * 1000;
const ORIGIN = 'http://127.0.0.1:50000';
const NEXT = 'http://127.0.0.1:50001';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const body = (n = 1) => ({ installationID: id(n), secret: Buffer.alloc(32, n).toString('base64url') });
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'genesis-origin-recovery-')));
  await chmod(directory, 0o700); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'origin-recovery.json'); let time = Date.UTC(2026, 10, 15);
  const options = { path, token: TOKEN, now: () => time };
  return { directory, path, options, recovery: createOriginRecovery(options), time: () => time, advance: ms => { time += ms; } };
}
async function httpFixture(t) {
  const f = await fixture(t); const upstream = [];
  const server = createBridge({ token: TOKEN, allowedOrigins: [ORIGIN, 'https://trusted.example.test'], originRecoveryPath: f.path }, {
    originRecoveryNow: f.time, upstreamToken: 'fixture-upstream', fetch: async (url, options) => {
      upstream.push({ url, method: options.method ?? 'GET' });
      return Response.json({ hostID: id(90), hostName: 'Fixture Mac', providers: [] });
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { origin = ORIGIN, token = TOKEN, method = 'POST', data = body(), headers = {} } = {}) => fetch(base + path, {
    method, headers: { ...(origin === null ? {} : { Origin: origin }), ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(method === 'POST' ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}),
  });
  return { ...f, server, upstream, request };
}

test('renewal origin must be canonical literal IPv4 loopback with an unprivileged explicit port', () => {
  for (const value of ['http://127.0.0.1:1024', NEXT, 'http://127.0.0.1:65535']) assert.equal(isRecoveryOrigin(value), true);
  for (const value of [undefined, null, 'null', '*', 'http://127.0.0.1:80', 'http://127.0.0.1:1023', 'http://127.0.0.1:65536', 'http://127.0.0.1:99999',
    'http://127.0.0.1:05001', 'http://127.0.0.1', 'http://localhost:50001', 'http://127.1:50001', 'http://[::1]:50001',
    'https://127.0.0.1:50001', 'http://127.0.0.1:50001/', 'http://user@127.0.0.1:50001', 'http://127.0.0.1:50001?q=x', 'https://other.example.test']) assert.equal(isRecoveryOrigin(value), false, String(value));
});
test('enrollment persists hashes privately and repeated enroll/renew is idempotent', async t => {
  const f = await fixture(t), receipt = await f.recovery.enroll(body());
  assert.deepEqual(receipt, { ok: true, version: 1, expiresAt: new Date(f.time() + TTL).toISOString() });
  await f.recovery.enroll(body()); await f.recovery.renew(NEXT, body()); await f.recovery.renew(NEXT, body());
  const raw = await readFile(f.path, 'utf8'), state = JSON.parse(raw);
  assert.equal(raw.includes(TOKEN), false); assert.equal(raw.includes(body().secret), false);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  assert.equal(state.installations.length, 1); assert.equal(state.installations[0].origins.length, 1);
  assert.equal(await f.recovery.isAllowed(NEXT), true); assert.equal(await f.recovery.isAllowed(ORIGIN), false);
});
test('credentials and exact dynamic origins survive a bridge instance restart', async t => {
  const f = await fixture(t); await f.recovery.enroll(body()); await f.recovery.renew(NEXT, body());
  const restarted = createOriginRecovery(f.options);
  assert.equal(await restarted.isAllowed(NEXT), true);
  await restarted.renew('http://127.0.0.1:50002', body());
  assert.equal(await f.recovery.isAllowed('http://127.0.0.1:50002'), true);
});
test('wrong, missing, noncanonical and conflicting credentials cannot enroll an origin', async t => {
  const f = await fixture(t);
  await assert.rejects(f.recovery.renew(NEXT, body()), { code: 'recovery_not_paired' });
  await f.recovery.enroll(body());
  await assert.rejects(f.recovery.enroll({ ...body(), secret: body(2).secret }), { code: 'recovery_conflict' });
  await assert.rejects(f.recovery.renew(NEXT, { ...body(), secret: body(2).secret }), { code: 'recovery_not_paired' });
  for (const value of [{}, { ...body(), action: 'send' }, { ...body(), installationID: 'wrong' }, { ...body(), secret: 'x'.repeat(43) }, { ...body(), secret: body().secret + '=' }]) {
    await assert.rejects(f.recovery.enroll(value), { code: 'invalid_recovery' });
  }
  assert.equal(await f.recovery.isAllowed(NEXT), false);
});
test('expiry is rolling on successful renew/enroll and never extended by ordinary reads', async t => {
  const f = await fixture(t); await f.recovery.enroll(body()); await f.recovery.renew(NEXT, body());
  const original = await readFile(f.path, 'utf8'); f.advance(TTL - 1);
  assert.equal(await f.recovery.isAllowed(NEXT), true); assert.equal(await readFile(f.path, 'utf8'), original);
  const receipt = await f.recovery.renew(NEXT, body()); assert.equal(receipt.expiresAt, new Date(f.time() + TTL).toISOString());
  f.advance(TTL); assert.equal(await f.recovery.isAllowed(NEXT), false);
  await assert.rejects(f.recovery.renew(NEXT, body()), { code: 'recovery_expired' });
  await f.recovery.enroll(body()); await f.recovery.renew(NEXT, body()); assert.equal(await f.recovery.isAllowed(NEXT), true);
});
test('pairing-token rotation and local credential revocation remove dynamic trust', async t => {
  const f = await fixture(t); await f.recovery.enroll(body()); await f.recovery.renew(NEXT, body());
  const rotated = createOriginRecovery({ ...f.options, token: TOKEN + 'rotated' });
  assert.equal(await rotated.isAllowed(NEXT), false); await assert.rejects(rotated.renew(NEXT, body()), { code: 'recovery_not_paired' });
  await rotated.enroll(body(2)); await rotated.renew(NEXT, body(2)); assert.equal(await f.recovery.isAllowed(NEXT), false);
  const state = JSON.parse(await readFile(f.path, 'utf8')); state.installations = []; await writeFile(f.path, JSON.stringify(state));
  assert.equal(await rotated.isAllowed(NEXT), false); await assert.rejects(rotated.renew(NEXT, body(2)), { code: 'recovery_not_paired' });
});
test('installation cap is bounded and expired nonmatching entries can be reclaimed', async t => {
  const f = await fixture(t); for (let n = 1; n <= 8; n++) await f.recovery.enroll(body(n));
  await assert.rejects(f.recovery.enroll(body(9)), { code: 'recovery_limit' });
  f.advance(TTL);
  await assert.rejects(f.recovery.enroll({ ...body(1), secret: body(9).secret }), { code: 'recovery_conflict' });
  await f.recovery.enroll(body(9)); assert.equal(JSON.parse(await readFile(f.path, 'utf8')).installations.length, 1);
});
test('four origins per installation retain shared-origin trust from another installation', async t => {
  const f = await fixture(t); await f.recovery.enroll(body(1)); await f.recovery.enroll(body(2));
  await f.recovery.renew(NEXT, body(2));
  for (let port = 50001; port <= 50005; port++) { await f.recovery.renew(`http://127.0.0.1:${port}`, body(1)); f.advance(1); }
  const state = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(state.installations[0].origins.length, 4);
  assert.equal(state.installations[0].origins.some(entry => entry.origin === NEXT), false);
  assert.equal(await f.recovery.isAllowed(NEXT), true);
  state.installations = state.installations.filter(entry => entry.installationID === id(1)); await writeFile(f.path, JSON.stringify(state));
  assert.equal(await f.recovery.isAllowed(NEXT), false);
});
test('concurrent writes and lost-response retries preserve every enrollment exactly once', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, n) => f.recovery.enroll(body(n + 1))));
  await Promise.all(Array.from({ length: 8 }, (_, n) => f.recovery.renew(`http://127.0.0.1:${51000 + n}`, body(n + 1))));
  await Promise.all(Array.from({ length: 8 }, () => f.recovery.renew('http://127.0.0.1:51000', body(1))));
  const state = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(state.installations.length, 8); assert.equal(state.installations.every(entry => entry.origins.length === 1), true);
});
test('saturated registry work fails closed at a bounded queue and recovers after draining', async t => {
  const f = await fixture(t); await f.recovery.enroll(body()); await f.recovery.renew(NEXT, body());
  const allowed = await Promise.all(Array.from({ length: 100 }, () => f.recovery.isAllowed(NEXT)));
  assert.equal(allowed.filter(Boolean).length, 32); assert.equal(allowed.filter(value => !value).length, 68);
  assert.equal(await f.recovery.isAllowed(NEXT), true);
});
test('corrupt, oversized and permissive files fail closed without exposing private state', async t => {
  const f = await fixture(t);
  for (const content of ['{"secret":"PRIVATE', ' '.repeat(32769), '{}', JSON.stringify({ version: 1, tokenFingerprint: ['a'.repeat(64)], installations: [] })]) {
    await writeFile(f.path, content, { mode: 0o600 });
    assert.equal(await f.recovery.isAllowed(NEXT), false);
    await assert.rejects(f.recovery.enroll(body()), error => error instanceof OriginRecoveryError && error.code === 'recovery_unavailable' && !String(error).includes('PRIVATE') && !String(error).includes(f.directory));
  }
  await rm(f.path); await f.recovery.enroll(body()); await chmod(f.path, 0o644);
  await assert.rejects(f.recovery.renew(NEXT, body()), { code: 'recovery_unavailable' });
});
test('symlinks, public directories, and failed writes cannot grant a new origin', async t => {
  const f = await fixture(t); await f.recovery.enroll(body());
  const copy = join(f.directory, 'copy.json'); await writeFile(copy, await readFile(f.path), { mode: 0o600 });
  await rm(f.path); await symlink(copy, f.path);
  await assert.rejects(f.recovery.renew(NEXT, body()), { code: 'recovery_unavailable' });
  await rm(f.path); await f.recovery.enroll(body());
  await chmod(f.directory, 0o755); await assert.rejects(f.recovery.renew(NEXT, body()), { code: 'recovery_unavailable' });
  await chmod(f.directory, 0o500); await assert.rejects(f.recovery.renew(NEXT, body()), { code: 'recovery_unavailable' });
  await chmod(f.directory, 0o700); assert.equal(await f.recovery.isAllowed(NEXT), false);
  const linked = join(f.directory, 'linked'); await symlink(f.directory, linked);
  await assert.rejects(createOriginRecovery({ ...f.options, path: join(linked, 'origin-recovery.json') }).enroll(body()), { code: 'recovery_unavailable' });
});
test('unusable recovery state leaves normal static-origin HTTP APIs usable', async t => {
  const f = await httpFixture(t);
  await assert.rejects(createOriginRecovery({ token: TOKEN }).enroll(body()), { code: 'recovery_unavailable' });
  await writeFile(f.path, 'corrupt private fixture', { mode: 0o600 });
  assert.equal((await f.request('/api/status', { method: 'GET' })).status, 200);
  assert.equal((await f.request('/api/status', { origin: NEXT, method: 'GET' })).status, 403);
  assert.equal((await f.request('/api/origin-recovery/renew', { origin: NEXT })).status, 503);
});
test('HTTP port change recovers with both credentials while normal bearer and origin checks remain', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/api/status', { origin: NEXT, method: 'GET' })).status, 403);
  assert.equal((await f.request('/api/origin-recovery/enroll')).status, 200);
  const preflight = await f.request('/api/origin-recovery/renew', { origin: NEXT, token: null, method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type',
  } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), NEXT);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.equal((await f.request('/api/status', { origin: NEXT, method: 'GET' })).status, 403);
  assert.equal((await f.request('/api/origin-recovery/renew', { origin: NEXT, token: null })).status, 401);
  assert.equal((await f.request('/api/origin-recovery/renew', { origin: NEXT, data: { ...body(), secret: body(2).secret } })).status, 401);
  assert.equal((await f.request('/api/origin-recovery/renew', { origin: NEXT })).status, 200);
  assert.equal((await f.request('/api/status', { origin: NEXT, method: 'GET' })).status, 200);
  assert.equal((await f.request('/api/status', { origin: NEXT, token: null, method: 'GET' })).status, 401);
  assert.equal((await f.request('/api/status', { origin: ORIGIN, method: 'GET' })).status, 200);
  assert.equal((await f.request('/api/status', { origin: 'http://127.0.0.1:50002', method: 'GET' })).status, 403);
  assert.equal(f.upstream.every(call => call.method === 'GET' && call.url.endsWith('/v1/status')), true);
});
test('only the dedicated renewal preflight gets an unknown exact local-origin exception', async t => {
  const f = await httpFixture(t);
  for (const path of ['/api/status', '/api/open', '/api/origin-recovery/enroll']) {
    assert.equal((await f.request(path, { origin: NEXT, method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } })).status, 403);
  }
  for (const origin of [null, 'null', '*', 'http://localhost:50001', 'http://127.0.0.1:99999', 'https://trusted.example.test']) {
    assert.equal((await f.request('/api/origin-recovery/renew', { origin, method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } })).status, 403);
  }
  for (const headers of [{ 'Access-Control-Request-Method': 'GET' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-unexpected' }]) {
    assert.equal((await f.request('/api/origin-recovery/renew', { origin: NEXT, method: 'OPTIONS', headers })).status, 403);
  }
  assert.equal(f.upstream.length, 0);
});
test('enrollment needs an existing trusted Origin plus bearer and never acts on GET or extra commands', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/api/origin-recovery/enroll', { origin: NEXT })).status, 403);
  assert.equal((await f.request('/api/origin-recovery/enroll', { origin: null })).status, 403);
  assert.equal((await f.request('/api/origin-recovery/enroll', { token: null })).status, 401);
  assert.equal((await f.request('/api/origin-recovery/enroll', { method: 'GET' })).status, 405);
  assert.equal((await f.request('/api/origin-recovery/enroll', { data: { ...body(), action: 'sendPrompt' } })).status, 422);
  assert.equal((await f.request('/api/origin-recovery/enroll', { data: 'x'.repeat(513) })).status, 413);
  assert.equal((await f.request('/api/origin-recovery/enroll?secret=ignored')).status, 403);
  assert.equal(f.upstream.length, 0); assert.equal(await f.recovery.isAllowed(NEXT), false);
});
