import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appCredentials, authorizeUrl, applyInstagramAuth, clearStoredAuth, connectionView, parseShortToken,
  saveStoredAuth, loadStoredAuth, signState, verifyState
} from '../src/ig-oauth.js';

const secret = 'instagram-app-secret';
const env = { IG_APP_ID: '1234567890', IG_APP_SECRET: secret };

test('arma la URL de Instagram Login y rechaza un state alterado', () => {
  assert.equal(appCredentials({}), null);
  const url = new URL(authorizeUrl({
    appId: env.IG_APP_ID,
    appSecret: secret,
    redirect: 'https://bot.example/oauth/instagram/callback',
    now: 1_000
  }));
  assert.equal(url.origin, 'https://www.instagram.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), env.IG_APP_ID);
  assert.match(url.searchParams.get('scope'), /instagram_business_manage_messages/);
  assert.equal(url.searchParams.get('force_reauth'), 'true');
  const state = url.searchParams.get('state');
  assert.equal(verifyState(state, secret, 1_000), true);
  assert.equal(verifyState(state, secret, 1_000 + 11 * 60 * 1000), false);
  assert.equal(verifyState(`${state}x`, secret, 1_000), false);
  assert.equal(verifyState(signState('otro-secreto', 1_000), secret, 1_000), false);
});

test('acepta las dos formas de token y no lo expone al panel', () => {
  assert.deepEqual(parseShortToken({ access_token: 'corto', user_id: '17841435502901961' }), {
    accessToken: 'corto', igUserId: '17841435502901961'
  });
  assert.equal(parseShortToken({ data: [{ access_token: 'otro', user_id: '17841435502901961' }] }).accessToken, 'otro');
  assert.throws(() => parseShortToken({ access_token: 'x' }), /token válido/);

  const config = { igAccessToken: 'viejo', igUserId: '1', igUsername: '' };
  assert.equal(applyInstagramAuth(config, {
    accessToken: 'nuevo', igUserId: '17841435502901961', username: 'lupoargentina'
  }), true);
  assert.equal(config.igAccessToken, 'nuevo');
  assert.equal(config.igUsername, 'lupoargentina');

  const view = connectionView({
    accessToken: 'secreto', igUserId: '17841435502901961', username: 'lupoargentina', expiresAt: 10
  }, { protocol: 'https', get: () => 'bot.example' }, env);
  assert.equal(view.connected, true);
  assert.equal(view.redirectUri, 'https://bot.example/oauth/instagram/callback');
  assert.equal('accessToken' in view, false);
});

test('guarda la cuenta en archivo sin MySQL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lupo-ig-'));
  const fileEnv = { ...env, DATA_DIR: dir };
  try {
    await saveStoredAuth({
      igUserId: '17841435502901961', username: 'lupoargentina', accessToken: 'largo', expiresAt: 99
    }, fileEnv);
    const stored = await loadStoredAuth(fileEnv);
    assert.equal(stored.accessToken, 'largo');
    assert.equal(stored.username, 'lupoargentina');
    await clearStoredAuth(fileEnv);
    assert.equal(await loadStoredAuth(fileEnv), null);
    await clearStoredAuth(fileEnv);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
