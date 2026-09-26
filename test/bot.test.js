import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { answerFor, publicCommentFor, privateReplyFor, setCatalog, getCatalog, resetCatalog, previewFor, privateCommentNotice } from '../src/replies.js';
import { verifySignature, extractEvents, graphPost, escapeUnicodeForMeta } from '../src/meta.js';
import { processEvent, resetTestState } from '../src/bot.js';

const cfg = { igUserId: 'ig123', fbPageId: 'page123', igAccessToken: 'IG_TEST',
  fbPageAccessToken: 'FB_TEST', igPrivateReplies: false, dryRun: true,
  storeUrl: 'https://lupo.ar', apiVersion: 'v26.0' };

test('clasifica mayorista, precios, talles, reclamos y no inventa datos', () => {
  assert.equal(answerFor('Necesito lista MAYORISTA').intent, 'wholesale');
  assert.equal(answerFor('¿CUÁNTO cuesta?').intent, 'price');
  assert.equal(answerFor('talle para cadera 110').intent, 'size');
  assert.equal(answerFor('me llegó equivocado').handoff, true);
  assert.equal(answerFor('hola').handoff, false);
  assert.equal(answerFor('quiero hablar con un asesor').handoff, true);
  assert.doesNotMatch(answerFor('cuánto cuesta').text, /\$\s*\d+/);
  assert.equal(publicCommentFor('Hermosa foto'), null);
});

test('verifica HMAC sobre body raw, rechaza firmas incorrectas', () => {
  const body = Buffer.from('{"object":"page"}');
  const header = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
  assert.equal(verifySignature(body, header, 'secret'), true);
  assert.equal(verifySignature(body, header, '"secret"'), true);
  assert.equal(verifySignature(Buffer.from('{}'), header, 'secret'), false);
  assert.equal(verifySignature(body, undefined, 'secret'), false);
  const unicode = Buffer.from('{"text":"precio á"}');
  const escaped = escapeUnicodeForMeta(unicode.toString('utf8'));
  const unicodeHeader = 'sha256=' + createHmac('sha256', 'secret').update(escaped).digest('hex');
  assert.equal(verifySignature(unicode, unicodeHeader, 'secret'), true);
});

test('extrae DMs/comentarios en ambas redes y descarta ecos y respuestas anidadas', () => {
  const fb = extractEvents({ object: 'page', entry: [{ id: 'page123', messaging: [
    { sender: { id: 'c1' }, recipient: { id: 'page123' }, message: { mid: 'm1', text: 'Hola' } },
    { sender: { id: 'page123' }, recipient: { id: 'c1' }, message: { mid: 'm2', text: 'Eco', is_echo: true } }
  ], changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'f1', message: 'precio', from: { id: 'c1' } } }] }] });
  const ig = extractEvents({ object: 'instagram', entry: [{ id: 'ig123', changes: [
    { field: 'comments', value: { id: 'i1', text: 'Precio', from: { id: 'c1' } } },
    { field: 'comments', value: { id: 'i2', text: 'Respuesta', parent_id: 'i1', media: { id: 'm1' }, from: { id: 'c1' } } }
  ] }] });
  const igFlat = extractEvents({ object: 'instagram', entry: [{
    id: 'ig123', field: 'comments',
    value: { id: 'i3', text: 'Precio', from: { id: 'c1' }, media: { id: 'm9' }, parent_id: 'm9' }
  }] });
  assert.deepEqual(fb.map((x) => x.id), ['m1', 'f1']);
  assert.deepEqual(igFlat.map((x) => x.id), ['i3']);
  const igZero = extractEvents({ object: 'instagram', entry: [{
    id: '0', time: 1, changes: [{ field: 'comments', value: { id: 'i4', text: 'precio', parent_id: '999', from: { id: 'c1' } } }]
  }] });
  assert.deepEqual(ig.map((x) => x.id), ['i1']);
  assert.deepEqual(igZero.map((x) => x.id), ['i4']);
});

test('DM usa endpoint y evita duplicados; reclamos pausan respuestas del mismo cliente', async () => {
  resetTestState(); const sent = [];
  const send = async (req) => { sent.push(req); return { id: 'ok' }; };
  const event = { platform: 'facebook', kind: 'message', accountId: 'page123', id: 'm10', senderId: 'c1', text: 'precio?' };
  assert.equal((await processEvent(event, cfg, send)).action, 'dm_price');
  assert.equal((await processEvent(event, cfg, send)).action, 'duplicate');
  assert.equal(sent[0].body.recipient.id, 'c1');
  await processEvent({ ...event, id: 'm11', text: 'reclamo' }, cfg, send);
  assert.equal((await processEvent({ ...event, id: 'm12' }, cfg, send)).action, 'human_paused');
  assert.equal(sent.length, 2);
});

test('DM cooldown evita otra auto-respuesta al mismo cliente; handoff sí pasa', async () => {
  resetTestState(); const sent = [];
  const send = async (req) => { sent.push(req); return { id: 'ok' }; };
  const base = { platform: 'instagram', kind: 'message', accountId: 'ig123', senderId: 'c3' };
  assert.equal((await processEvent({ ...base, id: 'c1', text: 'hola' }, cfg, send)).action, 'dm_unknown');
  assert.equal((await processEvent({ ...base, id: 'c2', text: 'cómo estás?' }, cfg, send)).action, 'dm_cooldown');
  assert.equal((await processEvent({ ...base, id: 'c3', text: 'quiero hablar con un asesor' }, cfg, send)).action, 'dm_handoff');
  assert.equal(sent.length, 2);
  // Otro usuario no queda bloqueado por el cooldown del primero.
  assert.equal((await processEvent({ ...base, id: 'c4', senderId: 'c4', text: 'hola' }, cfg, send)).action, 'dm_unknown');
  assert.equal(sent.length, 3);
});

test('DM_COOLDOWN_HOURS=0 desactiva el cooldown por conversación', async () => {
  resetTestState(); const sent = [];
  const send = async (req) => { sent.push(req); return { id: 'ok' }; };
  const off = { ...cfg, dmCooldownHours: 0 };
  const base = { platform: 'instagram', kind: 'message', accountId: 'ig123', senderId: 'c5' };
  assert.equal((await processEvent({ ...base, id: 'd1', text: 'hola' }, off, send)).action, 'dm_unknown');
  assert.equal((await processEvent({ ...base, id: 'd2', text: 'hola de nuevo' }, off, send)).action, 'dm_unknown');
  assert.equal(sent.length, 2);
});

test('mensajes simultáneos con mismo ID no generan envíos duplicados', async () => {
  resetTestState(); let calls = 0;
  const event = { platform: 'instagram', kind: 'message', accountId: 'ig123', senderId: 'c9', id: 'm99', text: 'Mayorista' };
  const send = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); };
  const results = await Promise.all([processEvent(event, cfg, send), processEvent(event, cfg, send)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.action).sort(), ['dm_wholesale', 'duplicate']);
});

test('acepta el ID clásico y el de Instagram Login de la misma cuenta', async () => {
  resetTestState();
  const send = async () => ({ id: 'ok' });
  const dual = { ...cfg, igUserId: '38485506321095650,17841435502901961' };
  const event = { platform: 'instagram', kind: 'comment', accountId: '17841435502901961',
    id: 'i20', senderId: 'c2', text: 'Precio' };
  assert.equal((await processEvent(event, dual, send)).action, 'comment_price');
});

test('comentarios usan rutas distintas y no responden cuando no hay keyword', async () => {
  resetTestState(); const sent = [];
  const send = async (req) => { sent.push(req); return { id: 'ok' }; };
  const ig = { platform: 'instagram', kind: 'comment', accountId: 'ig123', id: 'i7', senderId: 'c2', text: 'Precio' };
  const fb = { platform: 'facebook', kind: 'comment', accountId: 'page123', id: 'f7', senderId: 'c2', text: 'Mayorista' };
  assert.equal((await processEvent(ig, cfg, send)).action, 'comment_price');
  assert.equal((await processEvent(fb, cfg, send)).action, 'comment_wholesale');
  assert.equal(sent[0].path, 'i7/replies');
  assert.equal(sent[1].path, 'f7/comments');
  assert.equal((await processEvent({ ...ig, id: 'i8', text: 'Qué lindo' }, cfg, send)).action, 'comment_without_keyword');
});

test('IG private reply sends once, followed by public reply only if enabled', async () => {
  resetTestState(); const sent = [];
  const event = { platform: 'instagram', kind: 'comment', accountId: 'ig123', id: 'i9', senderId: 'c1', text: 'Precio' };
  const send = async (req) => { sent.push(req); return { id: 'ok' }; };
  await processEvent(event, { ...cfg, igPrivateReplies: true }, send);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.recipient.comment_id, 'i9');
  assert.equal(sent[1].body.message, privateCommentNotice('i9'));
  assert.equal((await processEvent(event, { ...cfg, igPrivateReplies: true }, send)).action, 'duplicate');
});

test('Graph client dry run does not make network calls', async () => {
  const result = await graphPost({ platform: 'facebook', accountId: '123', dryRun: true,
    body: { message: { text: 'hola' } }, fetchFn: () => { throw Error('network called'); } });
  assert.equal(result.dryRun, true);
});

test('el catálogo editable cambia comentarios y se puede restaurar', () => {
  const original = getCatalog();
  try {
    const next = structuredClone(original);
    const price = next.intents.find((intent) => intent.id === 'price');
    price.comment = 'Comentario de prueba para precio.';
    setCatalog(next, { persist: false });
    assert.equal(publicCommentFor('¿precio?'), 'Comentario de prueba para precio.');
    assert.match(previewFor('precio').privateReply, /¿Te ayudo con algo más\?/);
    assert.equal(privateReplyFor('Qué lindo'), null);
  } finally {
    resetCatalog({ persist: false });
  }
  assert.equal(publicCommentFor('¿precio?'), original.intents.find((intent) => intent.id === 'price').comment);
});

test('rechaza un catálogo sin intención unknown o con regex rota', () => {
  assert.throws(() => setCatalog({ intents: [{ id: 'price', keywords: ['precio'], dm: 'x', comment: 'y' }] }, { persist: false }));
  const next = getCatalog();
  next.intents.find((intent) => intent.id === 'price').keywords = ['('];
  assert.throws(() => setCatalog(next, { persist: false }));
});

test('clasifica las consultas de Instagram en la intención pedida', () => {
  const cases = [
    ['quiero', 'promo_quiero', false],
    ['¿dónde está mi pedido?', 'claim', true],
    ['compré y no me llegó', 'claim', true],
    ['¿puedo cambiar el talle si no me queda?', 'exchange', false],
    ['¿tenés envío a Córdoba?', 'shipping', false],
    ['¿envían al interior?', 'shipping', false],
    ['precio?', 'price', false],
    ['info', 'price', false],
    ['¿cuánto sale el boxer negro?', 'price', false],
    ['¿hay en L?', 'stock', false],
    ['¿hay en XL?', 'stock', false],
    ['¿se puede pagar en cuotas?', 'payment', false],
    ['¿tienen descuento?', 'promo', false],
    ['vendo por mayor, ¿tienen lista?', 'wholesale', false],
    ['quiero hablar con una persona', 'handoff', true],
    ['😍', 'unknown', false]
  ];
  for (const [text, intent, handoff] of cases) {
    const result = answerFor(text);
    assert.equal(result.intent, intent, text);
    assert.equal(result.handoff, handoff, text);
  }
  assert.equal(publicCommentFor('😍'), null);
  assert.equal(publicCommentFor('quiero'), '¡Listo! 💙 Revisá tus mensajes 📩');
  assert.equal(answerFor('quiero comprar').intent, 'shop');
  assert.equal(answerFor('lo quiero').intent, 'promo_quiero');
  assert.equal(answerFor('envío personalizado').intent, 'shipping');
  assert.equal(answerFor('cambiar el talle').intent, 'exchange');
  assert.equal(answerFor('¿hay en la tienda?').intent, 'shop');
  assert.equal(answerFor('uso XL').intent, 'size');

  const opts = { storeUrl: 'https://lupo.ar', whatsappNumber: '5491170590570' };
  assert.match(answerFor('quiero', opts).text, /en https:\/\/lupo\.ar/);
  assert.match(answerFor('reclamo', opts).text, /: https:\/\/wa\.me\/5491170590570/);
  assert.doesNotMatch(answerFor('reclamo', opts).text, /  https:/);
  assert.doesNotMatch(answerFor('¿se puede pagar en cuotas?', opts).text, /Mercado Pago/i);
  assert.match(answerFor('¿se puede pagar en cuotas?', opts).text, /tarjeta o transferencia/);
  assert.doesNotMatch(publicCommentFor('precio') || '', /https?:/);
  assert.doesNotMatch(publicCommentFor('cuotas') || '', /https?:/);
});

test('alterna el aviso público y separa links pegados al texto', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(privateCommentNotice(`comentario-${i}`));
  assert.equal(seen.size, 3);

  const original = getCatalog();
  try {
    const next = structuredClone(original);
    next.intents.find((intent) => intent.id === 'shop').dm = 'Comprá en{{store}}.{{whatsapp}}';
    setCatalog(next, { persist: false });
    const text = answerFor('como compro', { storeUrl: 'https://lupo.ar', whatsappNumber: '5491170590570' }).text;
    assert.match(text, /en https:\/\/lupo\.ar/);
    assert.match(text, /\. https:\/\/wa\.me\/5491170590570/);
  } finally {
    resetCatalog({ persist: false });
  }
});

test('Graph client picks official Instagram host and bearer header', async () => {
  let req;
  await graphPost({ platform: 'instagram', accountId: 'ig123', token: 'abc', dryRun: false,
    body: { recipient: { id: 'customer' }, message: { text: 'ok' } },
    fetchFn: async (...args) => { req = args; return { ok: true, json: async () => ({ id: 'ok' }) }; }
  });
  assert.equal(req[0], 'https://graph.instagram.com/v26.0/ig123/messages');
  assert.equal(req[1].headers.Authorization, 'Bearer abc');
});
