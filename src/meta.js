import { createHmac, timingSafeEqual } from 'node:crypto';

export function cleanSecret(value) {
  return String(value ?? '').trim().replace(/^['"]+|['"]+$/g, '');
}

/** Meta signs an escaped-unicode form of the JSON, with lowercase \uXXXX. */
export function escapeUnicodeForMeta(text) {
  return String(text).replace(/[\u007f-\uffff]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function hmacHex(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function sameHash(expected, actual) {
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function signatureProblem(rawBody, header, appSecret) {
  const secret = cleanSecret(appSecret);
  if (!secret) return 'missing_secret';
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) return 'empty_body';
  if (typeof header !== 'string' || !header) return 'missing_header';
  if (!/^sha256=[a-f0-9]{64}$/i.test(header)) return 'bad_header';
  const actual = header.slice(7).toLowerCase();
  const utf8 = rawBody.toString('utf8');
  const expected = [
    hmacHex(secret, rawBody),
    hmacHex(secret, utf8),
    hmacHex(secret, escapeUnicodeForMeta(utf8))
  ];
  if (expected.some((hash) => sameHash(hash, actual))) return null;
  return 'mismatch';
}

export function verifySignature(rawBody, header, appSecret) {
  return signatureProblem(rawBody, header, appSecret) === null;
}

export function extractEvents(payload) {
  const events = [];
  for (const entry of payload?.entry ?? []) {
    const accountId = String(entry.id ?? '');
    for (const message of entry.messaging ?? []) {
      // No echoes, reactions, delivery/read confirmations or messages sent by ourselves.
      if (!message.message?.text || message.message.is_echo || !message.sender?.id ||
          String(message.sender.id) === accountId || !message.recipient?.id ||
          String(message.sender.id) === String(message.recipient.id)) continue;
      events.push({
        platform: payload.object === 'instagram' ? 'instagram' : 'facebook',
        kind: 'message', accountId, senderId: String(message.sender.id),
        id: String(message.message.mid ?? ''), text: message.message.text,
        timestamp: Number(message.timestamp ?? Date.now())
      });
    }
    if (payload.object === 'instagram') {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'comments') continue;
        const value = change.value ?? {};
        if (!value.id || !value.text) {
          console.log('[WEBHOOK] comment IG sin id o texto');
          continue;
        }
        if (value.parent_id) {
          console.log('[WEBHOOK] comment IG anidado ignorado');
          continue;
        }
        if (String(value.from?.id ?? '') === accountId) {
          console.log('[WEBHOOK] comment IG propio ignorado (no respondemos a lupoargentina)');
          continue;
        }
        events.push({ platform: 'instagram', kind: 'comment', accountId,
          senderId: String(value.from?.id ?? ''), username: value.from?.username ?? '',
          id: String(value.id), text: value.text, timestamp: Date.now() });
      }
    }
    if (payload.object === 'page') {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        if (change.field !== 'feed' || value.item !== 'comment' || value.verb !== 'add' ||
            !value.comment_id || !value.message || String(value.from?.id ?? '') === accountId) continue;
        events.push({ platform: 'facebook', kind: 'comment', accountId,
          senderId: String(value.from?.id ?? ''), id: String(value.comment_id),
          text: value.message, timestamp: Date.now() });
      }
    }
  }
  return events;
}

export async function graphPost({ platform, accountId, path, token, body, version = 'v26.0', dryRun = true, fetchFn = fetch }) {
  if (dryRun) return { dryRun: true, platform, path, body };
  if (!token) throw new Error(`Falta token de ${platform}`);
  const domain = platform === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const normalized = path || `${accountId}/messages`;
  // Never interpolate external URLs supplied by customers.
  if (!/^[a-zA-Z0-9_./-]+$/.test(normalized) || normalized.includes('..')) throw new Error('Ruta Graph inválida');
  const response = await fetchFn(`https://${domain}/${version}/${normalized}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Graph ${platform} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 700)}`);
  return data;
}
