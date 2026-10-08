import { answerFor, classify, publicCommentFor, privateReplyFor, privateCommentNotice } from './replies.js';
import { graphPost } from './meta.js';
import { getProductForMedia } from './media-products.js';
import { isMediaIgnored } from './ignored-media.js';

const recent = new Map();
const inFlight = new Set();
const privateAttempts = new Map();
const paused = new Map();
const dmCooldown = new Map();
const botMids = new Map();
const botOutboundUntil = new Map();
const humanActiveUntil = new Map();
const DEDUP_MS = 48 * 3600 * 1000;
const HANDOFF_PAUSE_MS = 24 * 3600 * 1000;
const DEFAULT_DM_COOLDOWN_MS = 24 * 3600 * 1000;
const BOT_ECHO_WINDOW_MS = 2 * 60 * 1000;
const DEFAULT_HUMAN_ACTIVE_WINDOW_MS = 2 * 3600 * 1000;

function cleanExpired(now = Date.now()) {
  for (const [key, until] of recent) if (until <= now) recent.delete(key);
  for (const [key, until] of paused) if (until <= now) paused.delete(key);
  for (const [key, until] of privateAttempts) if (until <= now) privateAttempts.delete(key);
  for (const [key, until] of dmCooldown) if (until <= now) dmCooldown.delete(key);
  for (const [key, until] of botMids) if (until <= now) botMids.delete(key);
  for (const [key, until] of botOutboundUntil) if (until <= now) botOutboundUntil.delete(key);
  for (const [key, until] of humanActiveUntil) if (until <= now) humanActiveUntil.delete(key);
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

/** Hours from config; 0 disables. Default 2h when unset. */
function humanActiveWindowMs(config) {
  const raw = config?.humanActiveWindowHours;
  if (raw === 0 || raw === '0') return 0;
  if (raw == null || raw === '') return DEFAULT_HUMAN_ACTIVE_WINDOW_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_HUMAN_ACTIVE_WINDOW_MS;
  return hours * 3600 * 1000;
}

function idList(value) {
  return String(value ?? '').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function threadKeys(platform, accountIds, senderId) {
  const ids = [...new Set(accountIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
  return ids.map((id) => `${platform}:${id}:${senderId}`);
}

function markBotOutbound(platform, accountIds, senderId) {
  if (!senderId) return;
  const until = Date.now() + BOT_ECHO_WINDOW_MS;
  for (const key of threadKeys(platform, accountIds, senderId)) botOutboundUntil.set(key, until);
}

function noteBotMid(response) {
  const mid = response?.message_id || response?.message?.mid;
  if (mid) botMids.set(String(mid), Date.now() + DEDUP_MS);
}

function echoFromBot(event, keys, now = Date.now()) {
  if (event.id && botMids.has(event.id)) return true;
  return keys.some((key) => (botOutboundUntil.get(key) ?? 0) > now);
}

function renderMappingReply(template, product, opts) {
  const store = String(opts.storeUrl || 'https://lupo.ar').replace(/\/+$/, '');
  const whatsapp = /^\d{10,15}$/.test(String(opts.whatsappNumber || ''))
    ? `https://wa.me/${opts.whatsappNumber}`
    : 'este mismo chat';
  return String(template ?? '')
    .replace(/(\S)\{\{(store|whatsapp|nombre|url)\}\}/g, '$1 {{$2}}')
    .replaceAll('{{store}}', store)
    .replaceAll('{{whatsapp}}', whatsapp)
    .replaceAll('{{nombre}}', product.productName)
    .replaceAll('{{url}}', product.productUrl);
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
  if (!['facebook', 'instagram'].includes(event.platform)) return { action: 'ignored' };

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
  if (event.kind === 'echo') {
    if (!event.senderId || expectedIds.includes(String(event.senderId))) return { action: 'ignored' };
    const keys = threadKeys(event.platform, [accountId, ...expectedIds], event.senderId);
    if (echoFromBot(event, keys)) {
      const coolMs = dmCooldownMs(config);
      if (coolMs > 0) for (const key of keys) dmCooldown.set(key, Date.now() + coolMs);
      return { action: 'outbound_seen' };
    }
    // Sent from the Instagram app (a story share or a manual DM). This chat stays with the human.
    const until = Date.now() + HANDOFF_PAUSE_MS;
    for (const key of keys) paused.set(key, until);
    // Also mark that a human is actively handling this conversation.
    const activeMs = humanActiveWindowMs(config);
    if (activeMs > 0) {
      const activeUntil = Date.now() + activeMs;
      for (const key of keys) humanActiveUntil.set(key, activeUntil);
    }
    return { action: 'human_outbound' };
  }
  if (!['comment', 'message'].includes(event.kind) || !event.id || !event.text || isSelf(event, config)) {
    return { action: 'ignored' };
  }
  const key = `${event.platform}:${event.kind}:${accountId}:${event.id}`;
  if (recent.has(key) || inFlight.has(key)) return { action: 'duplicate' };
  if (event.kind === 'comment' && event.mediaId && isMediaIgnored(event.mediaId)) {
    recent.set(key, Date.now() + DEDUP_MS);
    return { action: 'ignored_media' };
  }
  const customerKey = `${event.platform}:${accountId}:${event.senderId}`;
  if (event.kind === 'message' && paused.has(customerKey)) return { action: 'human_paused' };
  // If a human recently replied in this conversation, stay silent (conversation is "open").
  if (event.kind === 'message' && humanActiveUntil.has(customerKey)) return { action: 'human_active' };

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
    // A reply to a story or to a message already in the thread is not a new chat.
    if ((event.storyReply || event.replyTo) && result.intent === 'unknown') {
      recent.set(key, Date.now() + DEDUP_MS);
      if (coolMs > 0) dmCooldown.set(customerKey, Date.now() + coolMs);
      return { action: event.storyReply ? 'story_reply' : 'thread_reply' };
    }
    // Once the chat is open, stay quiet. The human continues the thread alone.
    if (coolMs > 0 && dmCooldown.has(customerKey)) {
      recent.set(key, Date.now() + DEDUP_MS);
      return { action: 'dm_cooldown' };
    }
    const text = result.text;
    markBotOutbound(event.platform, [accountId, ...expectedIds], event.senderId);
    noteBotMid(await send({ ...common, body: {
      recipient: { id: event.senderId },
      messaging_type: event.platform === 'facebook' ? 'RESPONSE' : undefined,
      message: { text }
    }}));
    action = `dm_${result.intent}`;
    if (coolMs > 0) dmCooldown.set(customerKey, Date.now() + coolMs);
    if (result.handoff) {
      paused.set(customerKey, Date.now() + HANDOFF_PAUSE_MS);
      // The existing Meta inbox is the human handoff interface. No external notification is sent.
      console.log(`[HUMAN REVIEW] ${event.platform} account=${expected} sender=${event.senderId} (revisar bandeja de Meta)`);
    }
  } else {
    const product = event.mediaId ? getProductForMedia(event.mediaId) : null;
    const intentId = product ? classify(event.text, opts).intent : '';
    const override = product?.replies?.[intentId] || {};
    const publicTemplate = override.comment || product?.comment || '';
    const privateTemplate = override.dm || product?.reply || '';
    const customPublic = product && publicTemplate ? renderMappingReply(publicTemplate, product, opts) : '';
    const customPrivate = product && privateTemplate ? renderMappingReply(privateTemplate, product, opts) : '';
    const text = customPublic || publicCommentFor(event.text, opts);
    if (!text && !product) return { action: 'comment_without_keyword' };
    // Optional IG private reply before public reply. Exactly one attempt per comment.
    let privateSent = false;
    if (event.platform === 'instagram' && config.igPrivateReplies && !privateAttempts.has(key)) {
      let privateText = customPrivate || privateReplyFor(event.text, opts);
      if (!customPrivate && product && privateText) {
        privateText = `${privateText}\n\n🛒 ${product.productName}: ${product.productUrl}`;
      } else if (!customPrivate && product && !privateText) {
        privateText = `¡Hola! 💙 Acá tenés el link del producto:\n\n🛒 ${product.productName}: ${product.productUrl}`;
      }
      if (privateText) {
        try {
          // Mark BEFORE sending: delivery may have succeeded even if a timeout occurs.
          privateAttempts.set(key, Date.now() + 8 * 24 * 3600 * 1000);
          markBotOutbound(event.platform, [accountId, ...expectedIds], event.senderId);
          noteBotMid(await send({ ...common, body: { recipient: { comment_id: event.id }, message: { text: privateText } } }));
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
    const publicMessage = customPublic || (privateSent ? privateCommentNotice(event.id) : text);
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
  botMids.clear(); botOutboundUntil.clear(); humanActiveUntil.clear();
}
