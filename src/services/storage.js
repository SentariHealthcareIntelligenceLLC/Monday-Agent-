'use strict';
/**
 * Photo-proof storage. Two backends, matching the two deployment shapes:
 *
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY -> Supabase Storage (Vercel)
 *   otherwise                                -> local disk (Docker/dev)
 *
 * Only the object *path* is stored in the database. Images are served back
 * through short-lived signed URLs so the bucket can stay private — these are
 * photographs taken inside clinical spaces and should not sit on a public URL.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');

const TYPES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic',
};
const MAX_BYTES = 10 * 1024 * 1024;

const usingSupabase = () => Boolean(config.supabase.url && config.supabase.serviceKey);

/** Namespaced, unguessable object path. */
function objectPath(kind, id, contentType) {
  const ext = TYPES[contentType] || '.bin';
  return `${kind}/${id}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

function validate(buffer, contentType) {
  if (!TYPES[contentType]) {
    throw new Error(`unsupported image type: ${contentType || 'unknown'}`);
  }
  if (!buffer || !buffer.length) throw new Error('empty upload');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`image too large: ${Math.round(buffer.length / 1024 / 1024)}MB (max 10MB)`);
  }
}

const localRoot = () => path.resolve(config.storage.localDir);

async function put(kind, id, buffer, contentType) {
  validate(buffer, contentType);
  const key = objectPath(kind, id, contentType);

  if (!usingSupabase()) {
    const file = path.join(localRoot(), key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    return key;
  }

  const url = `${config.supabase.url}/storage/v1/object/${config.storage.bucket}/${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.supabase.serviceKey}`,
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!res.ok) {
    const detail = await res.text();
    logger.error({ status: res.status, detail }, 'Storage upload failed');
    throw new Error(`storage upload failed (${res.status})`);
  }
  return key;
}

/** A time-limited URL for one object, or a local path for the disk backend. */
async function signedUrl(key, expiresIn = 3600) {
  if (!key) return null;
  if (!usingSupabase()) return `/uploads/${key}`;

  const url = `${config.supabase.url}/storage/v1/object/sign/${config.storage.bucket}/${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.supabase.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) {
    logger.error({ status: res.status, key }, 'Signed URL failed');
    return null;
  }
  const json = await res.json();
  return `${config.supabase.url}/storage/v1${json.signedURL}`;
}

/** Read an object back (used by the local /uploads route). */
function readLocal(key) {
  const file = path.join(localRoot(), key);
  const resolved = path.resolve(file);
  // Reject anything that escapes the upload root.
  if (!resolved.startsWith(localRoot() + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return fs.readFileSync(resolved);
}

module.exports = { put, signedUrl, readLocal, usingSupabase, TYPES, MAX_BYTES };
