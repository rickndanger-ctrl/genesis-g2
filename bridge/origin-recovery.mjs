import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const LIFETIME = 90 * 24 * 60 * 60 * 1000;
const MAX_INSTALLATIONS = 8, MAX_ORIGINS = 4, MAX_STATE_BYTES = 32768;
const MAX_PENDING_OPERATIONS = 32;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 - LIFETIME;
const equalHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class OriginRecoveryError extends Error {
  constructor(status, code, message) { super(message); this.name = 'OriginRecoveryError'; Object.assign(this, { status, code }); }
}
function unavailableError() { return new OriginRecoveryError(503, 'recovery_unavailable', 'Automatic connection recovery is unavailable. Reconnect this app from a trusted origin.'); }
function unavailable() { throw unavailableError(); }
function invalid() { throw new OriginRecoveryError(422, 'invalid_recovery', 'The saved connection recovery information is invalid.'); }
function denied(code = 'recovery_not_paired') { throw new OriginRecoveryError(401, code, 'This app needs a trusted connection before automatic recovery can continue.'); }

export function isRecoveryOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) return false;
  try {
    const url = new URL(value), port = Number(url.port);
    return value === url.origin && port >= 1024 && port <= 65535;
  } catch { return false; }
}
function credential(body) {
  if (!exact(body, ['installationID', 'secret']) || typeof body.installationID !== 'string' || !uuid.test(body.installationID)
      || typeof body.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.secret)) invalid();
  const bytes = Buffer.from(body.secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== body.secret) invalid();
  return { installationID: body.installationID.toLowerCase(), secretHash: digest('genesis-g2-origin-recovery-secret\0' + body.secret) };
}
function validateState(value) {
  if (!exact(value, ['version', 'tokenFingerprint', 'installations']) || value.version !== 1
      || typeof value.tokenFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenFingerprint) || !Array.isArray(value.installations) || value.installations.length > MAX_INSTALLATIONS) unavailable();
  const ids = new Set();
  for (const item of value.installations) {
    if (!exact(item, ['installationID', 'secretHash', 'expiresAt', 'origins']) || typeof item.installationID !== 'string'
        || !uuid.test(item.installationID) || item.installationID !== item.installationID.toLowerCase() || ids.has(item.installationID)
        || typeof item.secretHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.secretHash) || !timestamp(item.expiresAt) || !Array.isArray(item.origins) || item.origins.length > MAX_ORIGINS) unavailable();
    ids.add(item.installationID); const origins = new Set();
    for (const entry of item.origins) {
      if (!exact(entry, ['origin', 'lastUsedAt']) || !isRecoveryOrigin(entry.origin) || origins.has(entry.origin)
          || !timestamp(entry.lastUsedAt) || entry.lastUsedAt > item.expiresAt) unavailable();
      origins.add(entry.origin);
    }
  }
  return value;
}

// This file contains hashes, not bearer tokens or renewal secrets. Every path
// component must be real, and the immediate directory/file remain owner-only.
async function privateParent(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) unavailable();
  const parent = dirname(path); let cursor = parse(parent).root;
  for (const part of parent.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part); const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) unavailable();
  }
  const stat = await lstat(parent);
  if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 || await realpath(parent) !== parent) unavailable();
}
async function privateFile(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())
        || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_STATE_BYTES || stat.size === 0) unavailable();
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function readState(path, fingerprint) {
  await privateParent(path);
  const before = await privateFile(path);
  if (!before) return { version: 1, tokenFingerprint: fingerprint, installations: [] };
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const start = await file.stat();
    if (start.dev !== before.dev || start.ino !== before.ino || start.size !== before.size) unavailable();
    const buffer = Buffer.alloc(start.size); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) unavailable(); offset += bytesRead;
    }
    const end = await file.stat();
    if (end.size !== start.size || end.mtimeMs !== start.mtimeMs) unavailable();
    const state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
    // A rotated pairing token invalidates every old credential and origin.
    return equalHash(state.tokenFingerprint, fingerprint) ? state : { version: 1, tokenFingerprint: fingerprint, installations: [] };
  } finally { await file.close(); }
}
async function writeState(path, state) {
  const data = Buffer.from(JSON.stringify(validateState(state)) + '\n');
  if (data.length > MAX_STATE_BYTES) unavailable();
  await privateParent(path); await privateFile(path);
  const temporary = join(dirname(path), '.origin-recovery-' + randomUUID() + '.tmp');
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600); await file.writeFile(data); await file.sync(); await file.close(); file = null;
    await privateParent(path); await privateFile(path);
    await rename(temporary, path);
    // Publish only after atomic replacement has completed successfully.
  } finally {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function createOriginRecovery({ path, token, now = Date.now } = {}) {
  const fingerprint = digest('genesis-g2-origin-recovery-token\0' + (token ?? ''));
  let queue = Promise.resolve(), pending = 0;
  function serialized(operation) {
    if (pending >= MAX_PENDING_OPERATIONS) return Promise.reject(unavailableError());
    pending++;
    const run = queue.then(async () => {
      try {
        if (typeof token !== 'string' || token.length < 32 || !path) unavailable();
        const time = now(); if (!timestamp(time)) unavailable();
        return await operation(await readState(path, fingerprint), time);
      } catch (error) { if (error instanceof OriginRecoveryError) throw error; unavailable(); }
    });
    queue = run.catch(() => {}); return run.finally(() => { pending--; });
  }
  return {
    async isAllowed(origin) {
      if (!isRecoveryOrigin(origin)) return false;
      try { return await serialized((state, time) => state.installations.some(item => item.expiresAt > time && item.origins.some(entry => entry.origin === origin))); }
      catch { return false; }
    },
    async enroll(body) {
      const supplied = credential(body);
      return serialized(async (state, time) => {
        let item = state.installations.find(entry => entry.installationID === supplied.installationID);
        if (item && !equalHash(item.secretHash, supplied.secretHash)) throw new OriginRecoveryError(409, 'recovery_conflict', 'This installation already has different recovery information. Keep its saved credential.');
        if (!item) {
          state.installations = state.installations.filter(entry => entry.expiresAt > time);
          if (state.installations.length >= MAX_INSTALLATIONS) throw new OriginRecoveryError(409, 'recovery_limit', 'The maximum number of recovery installations has been reached.');
          item = { ...supplied, expiresAt: time + LIFETIME, origins: [] }; state.installations.push(item);
        }
        item.expiresAt = time + LIFETIME;
        await writeState(path, state);
        return { ok: true, version: 1, expiresAt: new Date(item.expiresAt).toISOString() };
      });
    },
    async renew(origin, body) {
      if (!isRecoveryOrigin(origin)) throw new OriginRecoveryError(403, 'origin_denied', 'Only this app\'s exact local origin can be renewed.');
      const supplied = credential(body);
      return serialized(async (state, time) => {
        const item = state.installations.find(entry => entry.installationID === supplied.installationID);
        if (!item || !equalHash(item.secretHash, supplied.secretHash)) denied();
        if (item.expiresAt <= time) denied('recovery_expired');
        item.expiresAt = time + LIFETIME;
        item.origins = [...item.origins.filter(entry => entry.origin !== origin), { origin, lastUsedAt: time }].slice(-MAX_ORIGINS);
        await writeState(path, state);
        return { ok: true, version: 1, expiresAt: new Date(item.expiresAt).toISOString() };
      });
    },
  };
}
