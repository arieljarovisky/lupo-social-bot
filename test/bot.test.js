import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { answerFor, publicCommentFor, privateReplyFor, setCatalog, getCatalog, resetCatalog, previewFor } from '../src/replies.js';
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

test('mensajes simultáneos con mismo ID no generan envíos duplicados', async () => {
  resetTestState(); let calls = 0;
  const event = { platform: 'instagram', kind: 'message', accountId: 'ig123', senderId: 'c9', id: 'm99', text: 'Mayorista' };
  const send = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); };
  const results = await Promise.all([processEvent(event, cfg, send), processEvent(event, cfg, send)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.action).sort(), ['dm_wholesale', 'duplicate']);
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
  assert.equal(sent[1].body.message, '¡Hola! 💙 Te enviamos información por privado.');
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
    assert.match(previewFor('precio').privateReply, /Si querés continuar/);
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

test('Graph client picks official Instagram host and bearer header', async () => {
  let req;
  await graphPost({ platform: 'instagram', accountId: 'ig123', token: 'abc', dryRun: false,
    body: { recipient: { id: 'customer' }, message: { text: 'ok' } },
    fetchFn: async (...args) => { req = args; return { ok: true, json: async () => ({ id: 'ok' }) }; }
  });
  assert.equal(req[0], 'https://graph.instagram.com/v26.0/ig123/messages');
  assert.equal(req[1].headers.Authorization, 'Bearer abc');
});
