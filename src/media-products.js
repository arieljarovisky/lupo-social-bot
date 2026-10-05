import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataFile } from './data-dir.js';
import {
  deleteMediaMapping,
  insertMediaMapping,
  isMysqlConfigured,
  loadMappings,
  saveMappings,
  updateMediaMapping
} from './db.js';

const DATA_PATH = dataFile('media-products.json');
const MEDIA_ID_RE = /^\d{10,25}$/;
const INTENT_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const URL_RE = /^https?:\/\/.+/;
const MAX_MAPPINGS = 500;
const MAX_NAME_LENGTH = 120;
const MAX_REPLY = 800;
const MAX_COMMENT = 400;

const DEFAULTS = { version: 1, mappings: [] };

let store = loadFromDisk();

function loadFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    return validateStore(raw);
  } catch (err) {
    console.error('[MEDIA-PRODUCTS] No se pudo leer data/media-products.json, uso valores por defecto:', err.message);
    return structuredClone(DEFAULTS);
  }
}

function persistFile(next) {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  const tmp = `${DATA_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, DATA_PATH);
}

async function persist(next) {
  if (isMysqlConfigured()) {
    await saveMappings(next.mappings);
    return;
  }
  persistFile(next);
}

export function defaultMediaStore() {
  return structuredClone(DEFAULTS);
}

/** Reload mappings from MySQL after initDb. No-op in file mode. */
export async function hydrateMappings() {
  if (!isMysqlConfigured()) return getMappings();
  const stored = await loadMappings();
  if (stored == null) {
    store = structuredClone(DEFAULTS);
    return getMappings();
  }
  try {
    store = validateStore({ version: 1, mappings: stored });
  } catch (err) {
    console.error('[MEDIA-PRODUCTS] Datos MySQL inválidos, uso defaults:', err.message);
    store = structuredClone(DEFAULTS);
  }
  return getMappings();
}

export function validateStore(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.mappings)) {
    throw new Error('El archivo debe incluir una lista de mappings.');
  }
  if (input.mappings.length > MAX_MAPPINGS) {
    throw new Error(`Máximo ${MAX_MAPPINGS} mappings permitidos.`);
  }
  const seen = new Set();
  const mappings = input.mappings.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Mapping inválido en la posición ${index + 1}.`);
    }
    const mediaId = String(raw.mediaId ?? '').trim();
    if (!MEDIA_ID_RE.test(mediaId)) {
      throw new Error(`El mediaId "${mediaId || '(vacío)'}" no es válido (posición ${index + 1}).`);
    }
    if (seen.has(mediaId)) {
      throw new Error(`Hay dos mappings con el mismo mediaId "${mediaId}".`);
    }
    seen.add(mediaId);
    const productUrl = String(raw.productUrl ?? '').trim();
    if (!URL_RE.test(productUrl)) {
      throw new Error(`La URL del producto "${productUrl || '(vacía)'}" no es válida (posición ${index + 1}).`);
    }
    const productName = String(raw.productName ?? '').trim().slice(0, MAX_NAME_LENGTH);
    if (!productName) {
      throw new Error(`El nombre del producto está vacío (posición ${index + 1}).`);
    }
    const reply = String(raw.reply ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_REPLY);
    const comment = String(raw.comment ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_COMMENT);
    return {
      mediaId,
      productUrl,
      productName,
      reply,
      comment,
      replies: cleanReplies(raw.replies),
      enabled: raw.enabled !== false
    };
  });
  return { version: 1, mappings };
}

function cleanReplies(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw);
  if (entries.length > 20) throw new Error('Hay demasiadas respuestas personalizadas en un post.');
  const replies = {};
  for (const [id, value] of entries) {
    if (!INTENT_ID_RE.test(id) || id === 'unknown' || !value || typeof value !== 'object') continue;
    const comment = String(value.comment ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_COMMENT);
    const dm = String(value.dm ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_REPLY);
    if (comment || dm) replies[id] = { comment, dm };
  }
  return replies;
}

export function getMappings() {
  return structuredClone(store.mappings);
}

export function getProductForMedia(mediaId) {
  if (!mediaId) return null;
  const id = String(mediaId).trim();
  const mapping = store.mappings.find((m) => m.mediaId === id && m.enabled);
  return mapping
    ? {
      productUrl: mapping.productUrl,
      productName: mapping.productName,
      reply: mapping.reply || '',
      comment: mapping.comment || '',
      replies: mapping.replies || {}
    }
    : null;
}

export async function addMapping(data, { persist: shouldPersist = true } = {}) {
  const mapping = validateStore({ version: 1, mappings: [data] }).mappings[0];
  if (store.mappings.some((m) => m.mediaId === mapping.mediaId)) {
    throw new Error(`Ya existe un mapping para el mediaId "${mapping.mediaId}".`);
  }
  if (store.mappings.length >= MAX_MAPPINGS) {
    throw new Error(`Máximo ${MAX_MAPPINGS} mappings permitidos.`);
  }
  store.mappings.push(mapping);
  if (shouldPersist) {
    if (isMysqlConfigured()) await insertMediaMapping(mapping);
    else persistFile(store);
  }
  return structuredClone(mapping);
}

export async function updateMapping(mediaId, data, { persist: shouldPersist = true } = {}) {
  const id = String(mediaId ?? '').trim();
  const index = store.mappings.findIndex((m) => m.mediaId === id);
  if (index === -1) {
    throw new Error(`No existe un mapping para el mediaId "${id}".`);
  }
  const updated = validateStore({ version: 1, mappings: [{ ...store.mappings[index], ...data, mediaId: id }] }).mappings[0];
  store.mappings[index] = updated;
  if (shouldPersist) {
    if (isMysqlConfigured()) await updateMediaMapping(id, updated);
    else persistFile(store);
  }
  return structuredClone(updated);
}

export async function deleteMapping(mediaId, { persist: shouldPersist = true } = {}) {
  const id = String(mediaId ?? '').trim();
  const index = store.mappings.findIndex((m) => m.mediaId === id);
  if (index === -1) {
    throw new Error(`No existe un mapping para el mediaId "${id}".`);
  }
  const [removed] = store.mappings.splice(index, 1);
  if (shouldPersist) {
    if (isMysqlConfigured()) await deleteMediaMapping(id);
    else persistFile(store);
  }
  return structuredClone(removed);
}

export async function setMappings(mappings, { persist: shouldPersist = true } = {}) {
  const next = validateStore({ version: 1, mappings });
  store = next;
  if (shouldPersist) await persist(next);
  return getMappings();
}

export async function resetMappings({ persist: shouldPersist = false } = {}) {
  store = structuredClone(DEFAULTS);
  if (shouldPersist) await persist(store);
  return getMappings();
}
