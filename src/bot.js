import { answerFor, publicCommentFor, privateReplyFor, privateCommentNotice } from './replies.js';
import { graphPost } from './meta.js';

const recent = new Map();
const inFlight = new Set();
const privateAttempts = new Map();
const paused = new Map();
const DEDUP_MS = 48 * 3600 * 1000;
const HANDOFF_PAUSE_MS = 24 * 3600 * 1000;

function cleanExpired(now = Date.now()) {
  for (const [key, until] of recent) if (until <= now) recent.delete(key);
  for (const [key, until] of paused) if (until <= now) paused.delete(key);
  for (const [key, until] of privateAttempts) if (until <= now) privateAttempts.delete(key);
}

function isSelf(event, config) {
  const ours = event.platform === 'instagram' ? config.igUserId : config.fbPageId;
  if (ours && event.senderId && String(event.senderId) === String(ours)) return true;
  if (event.platform === 'instagram' && config.igUsername && event.username &&
      event.username.toLowerCase() === config.igUsername.toLowerCase()) return true;
  return false;
}

export async function processEvent(event, config, send = graphPost) {
  cleanExpired();
  if (!['facebook', 'instagram'].includes(event.platform) || !['comment', 'message'].includes(event.kind) ||
      !event.accountId || !event.id || !event.text || isSelf(event, config)) return { action: 'ignored' };

  // Only handle events for accounts explicitly configured in this project.
  const expected = event.platform === 'instagram' ? config.igUserId : config.fbPageId;
  if (!expected || event.accountId !== String(expected)) {
    console.log(`[BOT] ignored_account platform=${event.platform} got=${event.accountId} expected=${expected}`);
    return { action: 'ignored_account' };
  }
  const key = `${event.platform}:${event.kind}:${event.accountId}:${event.id}`;
  if (recent.has(key) || inFlight.has(key)) return { action: 'duplicate' };
  const customerKey = `${event.platform}:${event.accountId}:${event.senderId}`;
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
  let action;

  if (event.kind === 'message') {
    await send({ ...common, body: {
      recipient: { id: event.senderId },
      messaging_type: event.platform === 'facebook' ? 'RESPONSE' : undefined,
      message: { text: result.text }
    }});
    action = `dm_${result.intent}`;
    if (result.handoff) {
      paused.set(customerKey, Date.now() + HANDOFF_PAUSE_MS);
      // The existing Meta inbox is the human handoff interface. No external notification is sent.
      console.log(`[HUMAN REVIEW] ${event.platform} account=${expected} sender=${event.senderId} (revisar bandeja de Meta)`);
    }
  } else {
    const text = publicCommentFor(event.text, opts);
    if (!text) return { action: 'comment_without_keyword' };
    // Optional IG private reply before public reply. Exactly one attempt per comment.
    let privateSent = false;
    if (event.platform === 'instagram' && config.igPrivateReplies && !privateAttempts.has(key)) {
      const privateText = privateReplyFor(event.text, opts);
      if (privateText) {
        try {
          // Mark BEFORE sending: delivery may have succeeded even if a timeout occurs.
          privateAttempts.set(key, Date.now() + 8 * 24 * 3600 * 1000);
          await send({ ...common, body: { recipient: { comment_id: event.id }, message: { text: privateText } } });
          privateSent = true;
        } catch (err) {
          // Never retry blindly: IG permits one private reply per comment.
          console.error(`[IG PRIVATE REPLY] ${event.id}:`, err.message);
        }
      }
    }
    const path = event.platform === 'instagram' ? `${event.id}/replies` : `${event.id}/comments`;
    await send({ ...common, path, body: { message: privateSent
      ? privateCommentNotice() : text } });
    action = `comment_${result.intent}${privateSent ? '_private' : ''}`;
  }
  // Mark only after successful API delivery (in DRY_RUN after successful simulation).
  recent.set(key, Date.now() + DEDUP_MS);
  return { action };
  } finally {
    inFlight.delete(key);
  }
}

export function resetTestState() { recent.clear(); paused.clear(); inFlight.clear(); privateAttempts.clear(); }
