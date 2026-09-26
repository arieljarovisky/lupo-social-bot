import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'replies.json');
const ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_INTENTS = 20;
const MAX_KEYWORDS = 30;
const MAX_DM = 800;
const MAX_COMMENT = 400;
const DEFAULT_NOTICE = '¡Hola! 💙 Te enviamos la info por privado 📩';
const DEFAULT_NOTICES = [
  DEFAULT_NOTICE,
  '¡Revisá tus mensajes! 💙',
  'Te mandamos la info por DM ✨'
];
const DEFAULT_SUFFIX = '¿Te ayudo con algo más? Respondé este mensaje y seguimos 💙';

const DEFAULTS = JSON.parse(readFileSync(DATA_PATH, 'utf8'));

let catalog = loadFromDisk();

function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function matches(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function compileKeywords(keywords) {
  return keywords.map((keyword) => new RegExp(keyword, 'i'));
}

function applyVars(text, { storeUrl = 'https://lupo.ar', whatsappNumber = '' } = {}) {
  const store = String(storeUrl || 'https://lupo.ar').replace(/\/+$/, '');
  const whatsapp = /^\d{10,15}$/.test(whatsappNumber)
    ? `https://wa.me/${whatsappNumber}`
    : 'este mismo chat';
  return String(text ?? '')
    .replace(/(\S)\{\{(store|whatsapp)\}\}/g, '$1 {{$2}}')
    .replaceAll('{{store}}', store)
    .replaceAll('{{whatsapp}}', whatsapp);
}

function cleanNotices(extrasIn) {
  const listed = Array.isArray(extrasIn.privateCommentNotices)
    ? extrasIn.privateCommentNotices.map((item) => cleanText(item, MAX_COMMENT)).filter(Boolean).slice(0, 8)
    : [];
  const primary = cleanText(extrasIn.privateCommentNotice, MAX_COMMENT);
  let notices = listed.length ? listed : (primary ? [primary] : DEFAULT_NOTICES);
  if (primary && !notices.includes(primary)) notices = [primary, ...notices].slice(0, 8);
  return {
    privateCommentNotice: notices[0] || DEFAULT_NOTICE,
    privateCommentNotices: notices.length ? notices : [DEFAULT_NOTICE],
    privateReplySuffix: cleanText(extrasIn.privateReplySuffix, 200) || DEFAULT_SUFFIX
  };
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').slice(0, max);
}

export function validateCatalog(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.intents)) {
    throw new Error('El catálogo debe incluir una lista de intenciones.');
  }
  if (input.intents.length === 0 || input.intents.length > MAX_INTENTS) {
    throw new Error(`Hace falta entre 1 y ${MAX_INTENTS} intenciones.`);
  }
  const extrasIn = input.extras && typeof input.extras === 'object' ? input.extras : {};
  const seen = new Set();
  let hasUnknown = false;
  const intents = input.intents.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Intención inválida en la posición ${index + 1}.`);
    const id = String(raw.id ?? '').trim();
    if (!ID_RE.test(id)) throw new Error(`El id "${id || '(vacío)'}" no es válido.`);
    if (seen.has(id)) throw new Error(`Hay dos intenciones con el id "${id}".`);
    seen.add(id);
    if (id === 'unknown') hasUnknown = true;
    const keywords = Array.isArray(raw.keywords) ? raw.keywords : [];
    if (keywords.length > MAX_KEYWORDS) throw new Error(`"${id}" tiene demasiadas palabras clave.`);
    const cleanedKeywords = keywords.map((keyword, keyIndex) => {
      const source = String(keyword ?? '').trim();
      if (!source || source.length > 80) throw new Error(`Palabra clave inválida en "${id}" (#${keyIndex + 1}).`);
      try { new RegExp(source, 'i'); } catch { throw new Error(`El patrón "${source}" de "${id}" no es una expresión válida.`); }
      return source;
    });
    if (id !== 'unknown' && cleanedKeywords.length === 0) {
      throw new Error(`"${id}" necesita al menos una palabra clave.`);
    }
    return {
      id,
      label: cleanText(raw.label || id, 60) || id,
      description: cleanText(raw.description || '', 180),
      handoff: Boolean(raw.handoff),
      keywords: cleanedKeywords,
      dm: cleanText(raw.dm, MAX_DM),
      comment: cleanText(raw.comment, MAX_COMMENT)
    };
  });
  if (!hasUnknown) throw new Error('Tiene que existir la intención "unknown" (respuesta cuando no hay coincidencia).');
  return {
    version: 1,
    extras: cleanNotices(extrasIn),
    intents
  };
}

function loadFromDisk() {
  try {
    return validateCatalog(JSON.parse(readFileSync(DATA_PATH, 'utf8')));
  } catch (err) {
    console.error('[REPLIES] No se pudo leer data/replies.json, uso valores por defecto:', err.message);
    return validateCatalog(DEFAULTS);
  }
}

function persist(next) {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  const tmp = `${DATA_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, DATA_PATH);
}

export function getCatalog() {
  return structuredClone(catalog);
}

export function setCatalog(input, { persist: shouldPersist = true } = {}) {
  const next = validateCatalog(input);
  if (shouldPersist) persist(next);
  catalog = next;
  return getCatalog();
}

export function resetCatalog({ persist: shouldPersist = false } = {}) {
  catalog = validateCatalog(DEFAULTS);
  if (shouldPersist) persist(catalog);
  return getCatalog();
}

export function classify(message, opts = {}) {
  const text = normalize(message);
  for (const intent of catalog.intents) {
    if (intent.id === 'unknown') continue;
    if (matches(text, compileKeywords(intent.keywords))) {
      return {
        intent: intent.id,
        handoff: intent.handoff,
        text: applyVars(intent.dm, opts),
        comment: applyVars(intent.comment, opts) || null
      };
    }
  }
  const unknown = catalog.intents.find((intent) => intent.id === 'unknown');
  return {
    intent: 'unknown',
    handoff: Boolean(unknown?.handoff),
    text: applyVars(unknown?.dm ?? '', opts),
    comment: applyVars(unknown?.comment ?? '', opts) || null
  };
}

/** Returns a conservative response. Never invents availability, prices or size. */
export function answerFor(message, opts = {}) {
  const result = classify(message, opts);
  return { intent: result.intent, handoff: result.handoff, text: result.text };
}

/** Avoid posting detailed customer info publicly or spamming unrelated comments. */
export function publicCommentFor(message, opts = {}) {
  return classify(message, opts).comment;
}

export function privateReplyFor(message, opts = {}) {
  const result = classify(message, opts);
  if (result.intent === 'unknown' && !result.comment && !catalog.intents.find((intent) => intent.id === 'unknown')?.dm) {
    return null;
  }
  if (result.intent === 'unknown') return null;
  const suffix = catalog.extras.privateReplySuffix;
  return suffix ? `${result.text}\n\n${suffix}` : result.text;
}

export function privateCommentNotice(seed = '') {
  const notices = (catalog.extras.privateCommentNotices || []).filter(Boolean);
  const list = notices.length ? notices : [catalog.extras.privateCommentNotice].filter(Boolean);
  if (!list.length) return DEFAULT_NOTICE;
  if (!seed || list.length === 1) return list[0];
  let hash = 0;
  const value = String(seed);
  for (let i = 0; i < value.length; i++) hash = (hash * 33 + value.charCodeAt(i)) >>> 0;
  return list[hash % list.length];
}

export function previewFor(message, opts = {}) {
  const result = classify(message, opts);
  return {
    intent: result.intent,
    handoff: result.handoff,
    dm: result.text,
    comment: result.comment,
    privateReply: privateReplyFor(message, opts)
  };
}
