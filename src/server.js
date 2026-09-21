import express from 'express';
import { verifySignature, extractEvents } from './meta.js';
import { processEvent } from './bot.js';
import { answerFor, publicCommentFor } from './replies.js';

const env = process.env;
const config = {
  apiVersion: env.META_API_VERSION || 'v26.0',
  igUserId: env.IG_USER_ID || '', igAccessToken: env.IG_ACCESS_TOKEN || '',
  igUsername: env.IG_USERNAME || '', fbPageId: env.FB_PAGE_ID || '',
  fbPageAccessToken: env.FB_PAGE_ACCESS_TOKEN || '',
  igPrivateReplies: env.IG_PRIVATE_REPLIES === 'true', dryRun: env.DRY_RUN !== 'false',
  storeUrl: env.STORE_URL || 'https://lupo.ar', whatsappNumber: env.WHATSAPP_NUMBER || ''
};
const app = express();
app.disable('x-powered-by');
app.get('/health', (_, res) => res.json({ ok: true, simulation: config.dryRun }));

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && env.META_VERIFY_TOKEN && token === env.META_VERIFY_TOKEN &&
      typeof challenge === 'string') return res.status(200).type('text/plain').send(challenge);
  return res.sendStatus(403);
});

// MUST keep the body raw for HMAC validation; do not use express.json() before this route.
app.post('/webhook', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
  if (!verifySignature(req.body, req.get('x-hub-signature-256'), env.META_APP_SECRET)) {
    return res.sendStatus(403);
  }
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); }
  catch { return res.sendStatus(400); }
  if (!['instagram', 'page'].includes(payload.object)) return res.sendStatus(404);
  const events = extractEvents(payload);
  // Acknowledge quickly. For production, enqueue durably BEFORE ACK (Redis/BullMQ).
  res.status(200).send('EVENT_RECEIVED');
  for (const event of events) {
    processEvent(event, config).then((result) => {
      console.log(`[${event.platform}/${event.kind}] ${result.action}`);
    }).catch((err) => {
      console.error(`[PROCESSING FAILURE] ${event.platform}/${event.kind} ${event.id}:`, err.message);
    });
  }
});

// Local-only simulator: never deployed publicly as it gives away reply logic.
app.use('/simulate', express.json({ limit: '8kb' }));
app.post('/simulate', (req, res) => {
  const ip = req.ip?.replace('::ffff:', '');
  if ((ip !== '127.0.0.1' && ip !== '::1') || !env.SIMULATOR_TOKEN ||
      req.get('x-simulator-token') !== env.SIMULATOR_TOKEN) return res.sendStatus(403);
  const text = String(req.body?.text ?? '').slice(0, 2000);
  res.json({ dm: answerFor(text, config), comment: publicCommentFor(text, config) });
});

const port = Number(env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Lupo bot listening on port ${port}, DRY_RUN=${config.dryRun}`);
});
