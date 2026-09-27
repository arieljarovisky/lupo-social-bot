import { answerFor, publicCommentFor, privateReplyFor, privateCommentNotice } from './replies.js';
import { graphPost } from './meta.js';
import { getProductForMedia } from './media-products.js';

const recent = new Map();
const inFlight = new Set();
const privateAttempts = new Map();
const paused = new Map();
const dmCooldown = new Map();
const DEDUP_MS = 48 * 3600 * 1000;
const HANDOFF_PAUSE_MS = 24 * 3600 * 1000;
const DEFAULT_DM_COOLDOWN_MS = 24 * 3600 * 1000;

function cleanExpired(now = Date.now()) {
  for (const [key, until] of recent) if (until <= now) recent.delete(key);
  for (const [key, until] of paused) if (until <= now) paused.delete(key);
  for (const [key, until] of privateAttempts) if (until <= now) privateAttempts.delete(key);
  for (const [key, until] of dmCooldown) if (until <= now) dmCooldown.delete(key);
}

/** Hours from config; 0 disables. Default 24h when unset. */
function dmCooldownMs(config) {
  const raw = config?.dmCooldownHours;
  if (raw === 0 || raw === '0') return 0;
  if (raw == null || raw === '') return DEFAULT_DM_COOLDOWN_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_DM_COOLDOWN_MS;
  return hours * 3600 * 1000;
}

function idList(value) {
  return String(value ?? '').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function renderMappingReply(product, opts) {
  const store = String(opts.storeUrl || 'https://lupo.ar').replace(/\/+$/, '');
  const whatsapp = /^\d{10,15}$/.test(String(opts.whatsappNumber || ''))
    ? `https://wa.me/${opts.whatsappNumber}`
    : 'este mismo chat';
  return String(product.reply)
    .replace(/(\S)\{\{(store|whatsapp|nombre|url)\}\}/g, '$1 {{$2}}')
    .replaceAll('{{store}}', store)
    .replaceAll('{{whatsapp}}', whatsapp)
    .replaceAll('{{nombre}}', product.productName)
    .replaceAll('{{url}}', product.productUrl);
}

function withoutOpeningGreeting(text) {
  const continued = String(text ?? '').replace(/^\s*¡?\s*hola\s*!?\s*(?:💙\s*)?/i, '').trim();
  return continued || String(text ?? '');
}

function isSelf(event, config) {
  const ours = event.platform === 'instagram' ? idList(config.igUserId) : idList(config.fbPageId);
  if (event.senderId && ours.includes(String(event.senderId))) return true;
  if (event.platform === 'instagram' && config.igUsername && event.username &&
      event.username.toLowerCase() === config.igUsername.toLowerCase()) return true;
  return false;
}

export async function processEvent(event, config, send = graphPost) {
  cleanExpired();
  if (!['facebook', 'instagram'].includes(event.platform) || !['comment', 'message'].includes(event.kind) ||
      !event.id || !event.text || isSelf(event, config)) return { action: 'ignored' };

  // Instagram Login and the classic IG ID are both valid for the same account.
  const expectedIds = event.platform === 'instagram' ? idList(config.igUserId) : idList(config.fbPageId);
  const expected = expectedIds[0] || '';
  const incoming = String(event.accountId || '');
  const accountKnown = incoming && incoming !== '0' ? expectedIds.includes(incoming) : event.platform === 'instagram';
  if (!expected || !accountKnown) {
    console.log(`[BOT] ignored_account platform=${event.platform} got=${incoming || '0'} expected=${expectedIds.join(',')}`);
    return { action: 'ignored_account' };
  }
  if (event.platform === 'facebook' && !incoming) return { action: 'ignored_account' };
  const accountId = incoming && incoming !== '0' ? incoming : expected;
  const key = `${event.platform}:${event.kind}:${accountId}:${event.id}`;
  if (recent.has(key) || inFlight.has(key)) return { action: 'duplicate' };
  const customerKey = `${event.platform}:${accountId}:${event.senderId}`;
  if (event.kind === 'message' && paused.has(customerKey)) return { action: 'human_paused' };

  // If delivery was delayed beyond the standard messaging window, avoid a proactive reply.
  const sentAt = event.timestamp && event.timestamp < 1e12 ? event.timestamp * 1000 : event.timestamp;
  if (event.kind === 'message' && sentAt && (sentAt > Date.now() + 60000 || Date.now() - sentAt >= 23 * 3600 * 1000)) {
    return { action: 'outside_message_window' };
  }
  inFlight.add(key);
  try {
    const opts = { storeUrl: config.storeUrl, whatsappNumber: config.whatsappNumber };
    const token = event.platform === 'instagram' ? config.igAccessToken : config.fbPageAccessToken;
  const common = { platform: event.platform, accountId: expected, token, version: config.apiVersion, dryRun: config.dryRun };
  const result = answerFor(event.text, opts);
  const coolMs = dmCooldownMs(config);
  let action;

  if (event.kind === 'message') {
    // After the chat is open, stay quiet unless the message matches a known reply.
    if (coolMs > 0 && dmCooldown.has(customerKey) && result.intent === 'unknown') {
      recent.set(key, Date.now() + DEDUP_MS);
      return { action: 'dm_cooldown' };
    }
    const alreadyChatting = coolMs > 0 && dmCooldown.has(customerKey);
    const text = alreadyChatting ? withoutOpeningGreeting(result.text) : result.text;
    await send({ ...common, body: {
      recipient: { id: event.senderId },
      messaging_type: event.platform === 'facebook' ? 'RESPONSE' : undefined,
      message: { text }
    }});
    action = `dm_${result.intent}`;
    if (coolMs > 0) dmCooldown.set(customerKey, Date.now() + coolMs);
    if (result.handoff) {
      paused.set(customerKey, Date.now() + HANDOFF_PAUSE_MS);
      // The existing Meta inbox is the human handoff interface. No external notification is sent.
      console.log(`[HUMAN REVIEW] ${event.platform} account=${expected} sender=${event.senderId} (revisar bandeja de Meta)`);
    }
  } else {
    const text = publicCommentFor(event.text, opts);
    const product = event.mediaId ? getProductForMedia(event.mediaId) : null;
    if (!text && !product) return { action: 'comment_without_keyword' };
    // Optional IG private reply before public reply. Exactly one attempt per comment.
    let privateSent = false;
    if (event.platform === 'instagram' && config.igPrivateReplies && !privateAttempts.has(key)) {
      let privateText = privateReplyFor(event.text, opts);
      if (product?.reply) {
        privateText = renderMappingReply(product, opts);
      } else if (product && privateText) {
        privateText = `${privateText}\n\n🛒 ${product.productName}: ${product.productUrl}`;
      } else if (product && !privateText) {
        privateText = `¡Hola! 💙 Acá tenés el link del producto:\n\n🛒 ${product.productName}: ${product.productUrl}`;
      }
      if (privateText) {
        try {
          // Mark BEFORE sending: delivery may have succeeded even if a timeout occurs.
          privateAttempts.set(key, Date.now() + 8 * 24 * 3600 * 1000);
          await send({ ...common, body: { recipient: { comment_id: event.id }, message: { text: privateText } } });
          privateSent = true;
          // That private message opens the chat. A later reply from the same person is not a new conversation.
          if (event.senderId && coolMs > 0) dmCooldown.set(customerKey, Date.now() + coolMs);
        } catch (err) {
          // Never retry blindly: IG permits one private reply per comment.
          console.error(`[IG PRIVATE REPLY] ${event.id}:`, err.message);
        }
      }
    }
    const path = event.platform === 'instagram' ? `${event.id}/replies` : `${event.id}/comments`;
    const publicMessage = privateSent ? privateCommentNotice(event.id) : text;
    if (publicMessage) {
      await send({ ...common, path, body: { message: publicMessage } });
    }
    action = `comment_${result.intent}${privateSent ? '_private' : ''}`;
  }
  // Mark only after successful API delivery (in DRY_RUN after successful simulation).
  recent.set(key, Date.now() + DEDUP_MS);
  return { action };
  } finally {
    inFlight.delete(key);
  }
}

export function resetTestState() {
  recent.clear(); paused.clear(); inFlight.clear(); privateAttempts.clear(); dmCooldown.clear();
}
