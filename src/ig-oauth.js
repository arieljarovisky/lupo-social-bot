import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMysqlConfigured, loadInstagramAuth, saveInstagramAuth } from './db.js';

const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments'
];
const STATE_MS = 10 * 60 * 1000;
const REFRESH_WINDOW_MS = 10 * 24 * 3600 * 1000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function clean(value) {
  return String(value ?? '').trim();
}

export function appCredentials(env = process.env) {
  const appId = clean(env.IG_APP_ID || env.INSTAGRAM_APP_ID);
  const appSecret = clean(env.IG_APP_SECRET || env.INSTAGRAM_APP_SECRET);
  if (!/^\d{5,32}$/.test(appId) || appSecret.length < 8) return null;
  return { appId, appSecret };
}

export function publicOrigin(req, env = process.env) {
  const configured = clean(env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  if (configured) return configured;
  const host = clean(req.get('host'));
  if (!host) throw new Error('No pude armar la URL de retorno.');
  return `${req.protocol}://${host}`;
}

export function redirectUri(req, env = process.env) {
  return `${publicOrigin(req, env)}/oauth/instagram/callback`;
}

export function signState(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    n: randomBytes(16).toString('hex'),
    exp: now + STATE_MS
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyState(state, secret, now = Date.now()) {
  const [payload, sig] = String(state ?? '').split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > now;
  } catch {
    return false;
  }
}

export function authorizeUrl({ appId, appSecret, redirect, now }) {
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(','));
  url.searchParams.set('force_reauth', 'true');
  url.searchParams.set('state', signState(appSecret, now));
  return url.toString();
}

export function parseShortToken(body) {
  const row = Array.isArray(body?.data) ? body.data[0] : body;
  const accessToken = clean(row?.access_token);
  const igUserId = clean(row?.user_id);
  if (!accessToken || !/^\d{5,32}$/.test(igUserId)) {
    throw new Error('Instagram no devolvió un token válido.');
  }
  return { accessToken, igUserId };
}

function authPath(env = process.env) {
  const dir = clean(env.DATA_DIR) || join(root, 'data');
  return join(dir, 'instagram-auth.json');
}

function readFileAuth(env = process.env) {
  try {
    const raw = JSON.parse(readFileSync(authPath(env), 'utf8'));
    if (!raw?.accessToken || !raw?.igUserId) return null;
    return {
      igUserId: String(raw.igUserId),
      username: String(raw.username || ''),
      accessToken: String(raw.accessToken),
      expiresAt: raw.expiresAt == null ? null : Number(raw.expiresAt)
    };
  } catch {
    return null;
  }
}

function writeFileAuth(record, env = process.env) {
  const path = authPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export async function loadStoredAuth(env = process.env) {
  if (isMysqlConfigured(env)) return loadInstagramAuth();
  return readFileAuth(env);
}

export async function saveStoredAuth(record, env = process.env) {
  if (isMysqlConfigured(env)) {
    await saveInstagramAuth(record);
    return;
  }
  writeFileAuth(record, env);
}

export function applyInstagramAuth(config, record) {
  if (!record?.accessToken || !record?.igUserId) return false;
  config.igAccessToken = record.accessToken;
  config.igUserId = String(record.igUserId);
  if (record.username) config.igUsername = record.username;
  return true;
}

export function connectionView(record, req, env = process.env) {
  const ready = Boolean(appCredentials(env));
  let redirect = '';
  try { redirect = redirectUri(req, env); } catch { redirect = ''; }
  return {
    ready,
    redirectUri: redirect,
    connected: Boolean(record?.accessToken && record?.igUserId),
    username: record?.username || '',
    igUserId: record?.igUserId ? String(record.igUserId) : '',
    expiresAt: record?.expiresAt ?? null
  };
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.error_message || `HTTP ${response.status}`;
    throw new Error(String(message).slice(0, 300));
  }
  return data;
}

export async function exchangeCode({ code, appId, appSecret, redirect, fetchFn = fetch }) {
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
    code: clean(code).replace(/#_$/, '')
  });
  const response = await fetchFn('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000)
  });
  return parseShortToken(await readJson(response));
}

export async function exchangeLongLived({ token, appSecret, fetchFn = fetch }) {
  const url = new URL('https://graph.instagram.com/access_token');
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('access_token', token);
  const response = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
  const data = await readJson(response);
  const accessToken = clean(data.access_token);
  const expiresIn = Number(data.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn)) throw new Error('Instagram no devolvió un token de larga duración.');
  return { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export async function fetchProfile({ token, version = 'v26.0', fetchFn = fetch }) {
  const url = new URL(`https://graph.instagram.com/${version}/me`);
  url.searchParams.set('fields', 'user_id,username');
  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000)
  });
  const data = await readJson(response);
  return {
    igUserId: clean(data.user_id || data.id),
    username: clean(data.username)
  };
}

export async function refreshLongLived({ token, fetchFn = fetch }) {
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);
  const response = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
  const data = await readJson(response);
  const accessToken = clean(data.access_token);
  const expiresIn = Number(data.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn)) throw new Error('Instagram no renovó el token.');
  return { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export async function completeLogin({ code, state, req, env = process.env, fetchFn = fetch, version = 'v26.0' }) {
  const creds = appCredentials(env);
  if (!creds) throw new Error('Faltan IG_APP_ID e IG_APP_SECRET en el servidor.');
  if (!verifyState(state, creds.appSecret)) throw new Error('El inicio de sesión venció. Volvé a tocar Conectar.');
  const redirect = redirectUri(req, env);
  const shortLived = await exchangeCode({ code, ...creds, redirect, fetchFn });
  const longLived = await exchangeLongLived({ token: shortLived.accessToken, appSecret: creds.appSecret, fetchFn });
  let profile = { igUserId: '', username: '' };
  try {
    profile = await fetchProfile({ token: longLived.accessToken, version, fetchFn });
  } catch (err) {
    console.error('[IG OAUTH] No pude leer el usuario:', String(err.message || err).slice(0, 200));
  }
  const record = {
    igUserId: profile.igUserId || shortLived.igUserId,
    username: profile.username,
    accessToken: longLived.accessToken,
    expiresAt: longLived.expiresAt
  };
  await saveStoredAuth(record, env);
  return record;
}

export async function hydrateInstagramAuth(config, env = process.env, fetchFn = fetch) {
  const stored = await loadStoredAuth(env);
  if (!stored?.accessToken) return null;
  let current = stored;
  const expiring = stored.expiresAt && stored.expiresAt - Date.now() < REFRESH_WINDOW_MS;
  if (expiring) {
    try {
      const refreshed = await refreshLongLived({ token: stored.accessToken, fetchFn });
      current = { ...stored, ...refreshed };
      await saveStoredAuth(current, env);
      console.log('[IG OAUTH] Token de Instagram renovado');
    } catch (err) {
      console.error('[IG OAUTH] No se pudo renovar el token:', String(err.message || err).slice(0, 200));
    }
  }
  applyInstagramAuth(config, current);
  const name = current.username || current.igUserId;
  console.log(`[IG OAUTH] Cuenta conectada: ${name}`);
  return current;
}
