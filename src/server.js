import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { signatureProblem, extractEvents, cleanSecret } from './meta.js';
import { processEvent } from './bot.js';
import { answerFor, publicCommentFor, getCatalog, setCatalog, previewFor } from './replies.js';

const env = process.env;
const config = {
  apiVersion: env.META_API_VERSION || 'v26.0',
  igUserId: env.IG_USER_ID || '', igAccessToken: env.IG_ACCESS_TOKEN || '',
  igUsername: env.IG_USERNAME || '', fbPageId: env.FB_PAGE_ID || '',
  fbPageAccessToken: env.FB_PAGE_ACCESS_TOKEN || '',
  igPrivateReplies: env.IG_PRIVATE_REPLIES === 'true', dryRun: env.DRY_RUN !== 'false',
  storeUrl: env.STORE_URL || 'https://lupo.ar', whatsappNumber: env.WHATSAPP_NUMBER || ''
};
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.get('/health', (_, res) => res.json({ ok: true, simulation: config.dryRun }));

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  const verifyToken = cleanSecret(env.META_VERIFY_TOKEN);
  if (mode === 'subscribe' && verifyToken && token === verifyToken &&
      typeof challenge === 'string') {
    console.log('[WEBHOOK] handshake ok');
    return res.status(200).type('text/plain').send(challenge);
  }
  console.log('[WEBHOOK] handshake rechazado (token o challenge inválido)');
  return res.sendStatus(403);
});

// MUST keep the body raw for HMAC validation; do not use express.json() before this route.
app.post('/webhook', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
  const header = req.get('x-hub-signature-256') || req.get('x-hub-signature') || '';
  const problem = signatureProblem(req.body, header, env.META_APP_SECRET);
  if (problem) {
    const detail = {
      missing_secret: 'falta META_APP_SECRET en Railway',
      empty_body: 'el body llegó vacío',
      missing_header: 'no vino X-Hub-Signature-256',
      bad_header: 'X-Hub-Signature-256 no tiene formato sha256',
      mismatch: 'firma no válida (el test de Meta suele fallar; un comentario real es la prueba)'
    }[problem] || problem;
    let peek = '';
    try {
      const parsed = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
      const fields = (parsed.entry ?? []).flatMap((entry) => (entry.changes ?? []).map((change) => change.field));
      peek = ` object=${parsed.object ?? 'sin-object'} fields=${fields.join(',') || '-'} bytes=${req.body?.length ?? 0}`;
    } catch {
      peek = ` bytes=${req.body?.length ?? 0} ctype=${req.get('content-type') || '-'}`;
    }
    console.log(`[WEBHOOK] POST rechazado: ${detail}${peek}`);
    return res.sendStatus(403);
  }
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); }
  catch {
    console.log('[WEBHOOK] POST rechazado: JSON inválido');
    return res.sendStatus(400);
  }
  if (!['instagram', 'page'].includes(payload.object)) {
    console.log(`[WEBHOOK] POST ignorado: object=${payload.object}`);
    return res.sendStatus(404);
  }
  const events = extractEvents(payload);
  if (!events.length) {
    const shape = (payload.entry ?? []).map((entry) => ({
      id: entry.id,
      keys: Object.keys(entry),
      fields: (entry.changes ?? []).map((change) => change.field),
      flatField: entry.field || null
    }));
    console.log(`[WEBHOOK] POST ${payload.object} eventos=0 shape=${JSON.stringify(shape)}`);
  } else {
    console.log(`[WEBHOOK] POST ${payload.object} eventos=${events.length}`);
  }
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

function clientIp(req) {
  return req.ip?.replace('::ffff:', '') || '';
}

function isLocal(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

function adminToken() {
  return env.ADMIN_TOKEN || env.SIMULATOR_TOKEN || '';
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function providedAdminToken(req) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer || req.get('x-admin-token') || '';
}

function isAuthorized(req) {
  const expected = adminToken();
  if (expected) return safeEqual(providedAdminToken(req), expected);
  return isLocal(req);
}

function requireAdmin(req, res, next) {
  if (isAuthorized(req)) return next();
  if (adminToken()) return res.status(401).json({ error: 'No autorizado. Ingresá el token del panel.' });
  return res.status(401).json({ error: 'Configurá ADMIN_TOKEN para usar el panel fuera de localhost.' });
}

const replyOpts = () => ({ storeUrl: config.storeUrl, whatsappNumber: config.whatsappNumber });

app.use('/api', express.json({ limit: '64kb' }));
app.get('/api/session', (req, res) => {
  res.json({
    ok: isAuthorized(req),
    authRequired: Boolean(adminToken()),
    local: isLocal(req)
  });
});
app.get('/api/replies', requireAdmin, (_req, res) => {
  res.json({
    catalog: getCatalog(),
    meta: {
      storeUrl: config.storeUrl,
      whatsappConfigured: /^\d{10,15}$/.test(config.whatsappNumber),
      igPrivateReplies: config.igPrivateReplies,
      dryRun: config.dryRun
    }
  });
});
app.put('/api/replies', requireAdmin, (req, res) => {
  try {
    const catalog = setCatalog(req.body);
    res.json({ ok: true, catalog });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/preview', requireAdmin, (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 2000);
  const previous = getCatalog();
  try {
    if (req.body?.catalog) setCatalog(req.body.catalog, { persist: false });
    res.json(previewFor(text, replyOpts()));
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    if (req.body?.catalog) setCatalog(previous, { persist: false });
  }
});

app.get('/admin', (_req, res) => res.sendFile(join(publicDir, 'admin.html')));
app.get('/', (_req, res) => res.redirect('/admin'));

// Local-only simulator: never deployed publicly as it gives away reply logic.
app.use('/simulate', express.json({ limit: '8kb' }));
app.post('/simulate', (req, res) => {
  if (!isLocal(req) || !env.SIMULATOR_TOKEN ||
      req.get('x-simulator-token') !== env.SIMULATOR_TOKEN) return res.sendStatus(403);
  const text = String(req.body?.text ?? '').slice(0, 2000);
  res.json({ dm: answerFor(text, config), comment: publicCommentFor(text, config) });
});

const port = Number(env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Lupo bot listening on port ${port}, DRY_RUN=${config.dryRun}`);
  console.log(`Panel de respuestas: http://127.0.0.1:${port}/admin`);
});
