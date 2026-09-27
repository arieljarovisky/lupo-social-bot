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

function usableAccountId(id) {
  const value = String(id ?? '');
  return !value || value === '0' ? '' : value;
}

export function extractEvents(payload) {
  const events = [];
  for (const entry of payload?.entry ?? []) {
    const accountId = usableAccountId(entry.id);
    for (const message of entry.messaging ?? []) {
      const msg = message.message;
      // Reactions, delivery and read receipts have no message body.
      if (!msg || !message.sender?.id || !message.recipient?.id ||
          String(message.sender.id) === String(message.recipient.id)) continue;
      const platform = payload.object === 'instagram' ? 'instagram' : 'facebook';
      const outbound = Boolean(msg.is_echo) || (accountId && String(message.sender.id) === accountId);
      if (outbound) {
        // A story share or DM sent from the inbox already opened the chat.
        const customerId = String(message.recipient.id);
        if (!customerId || customerId === accountId) continue;
        events.push({
          platform, kind: 'echo', accountId, senderId: customerId,
          id: String(msg.mid ?? ''), text: String(msg.text ?? ''),
          timestamp: Number(message.timestamp ?? Date.now())
        });
        continue;
      }
      if (!msg.text) continue;
      events.push({
        platform, kind: 'message', accountId, senderId: String(message.sender.id),
        id: String(msg.mid ?? ''), text: msg.text,
        timestamp: Number(message.timestamp ?? Date.now()),
        storyReply: Boolean(msg.reply_to?.story),
        replyTo: Boolean(msg.reply_to)
      });
    }
    if (payload.object === 'instagram') {
      const commentChanges = [...(entry.changes ?? [])];
      if (entry.field && entry.value) commentChanges.push({ field: entry.field, value: entry.value });
      for (const change of commentChanges) {
        if (change.field !== 'comments') continue;
        const value = change.value ?? {};
        const commentId = value.id || value.comment_id;
        const text = value.text || value.message;
        const mediaId = String(value.media?.id ?? value.media_id ?? '');
        const parentId = value.parent_id ? String(value.parent_id) : '';
        // Only treat as a thread reply when we can tell parent is another comment, not the post.
        const isReply = Boolean(parentId && mediaId && parentId !== mediaId);
        if (!commentId || !text) {
          console.log('[WEBHOOK] comment IG sin id o texto');
          continue;
        }
        if (isReply) {
          console.log('[WEBHOOK] comment IG anidado ignorado');
          continue;
        }
        if (String(value.from?.id ?? '') === accountId) {
          console.log('[WEBHOOK] comment IG propio ignorado (no respondemos a lupoargentina)');
          continue;
        }
        events.push({ platform: 'instagram', kind: 'comment', accountId,
          senderId: String(value.from?.id ?? ''), username: value.from?.username ?? '',
          id: String(commentId), text, timestamp: Date.now(), mediaId });
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

export function graphPath(path) {
  const normalized = String(path ?? '');
  if (!/^[a-zA-Z0-9_./-]+$/.test(normalized) || normalized.includes('..')) throw new Error('Ruta Graph inválida');
  return normalized;
}

export async function graphGet({ platform = 'instagram', path, query = {}, token, version = 'v26.0', fetchFn = fetch }) {
  if (!token) throw new Error(`Falta token de ${platform}`);
  const domain = platform === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  const response = await fetchFn(`https://${domain}/${version}/${graphPath(path)}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Graph ${platform} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 700)}`);
  return data;
}

export async function graphPost({ platform, accountId, path, token, body, version = 'v26.0', dryRun = true, fetchFn = fetch }) {
  if (dryRun) return { dryRun: true, platform, path, body };
  if (!token) throw new Error(`Falta token de ${platform}`);
  const domain = platform === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const normalized = graphPath(path || `${accountId}/messages`);
  const response = await fetchFn(`https://${domain}/${version}/${normalized}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Graph ${platform} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 700)}`);
  return data;
}
