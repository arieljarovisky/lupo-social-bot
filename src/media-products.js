import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'media-products.json');
const MEDIA_ID_RE = /^\d{10,25}$/;
const URL_RE = /^https?:\/\/.+/;
const MAX_MAPPINGS = 500;
const MAX_NAME_LENGTH = 120;
const MAX_REPLY = 800;

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

function persist(next) {
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  const tmp = `${DATA_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, DATA_PATH);
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
    return {
      mediaId,
      productUrl,
      productName,
      reply,
      enabled: raw.enabled !== false
    };
  });
  return { version: 1, mappings };
}

export function getMappings() {
  return structuredClone(store.mappings);
}

export function getProductForMedia(mediaId) {
  if (!mediaId) return null;
  const id = String(mediaId).trim();
  const mapping = store.mappings.find((m) => m.mediaId === id && m.enabled);
  return mapping
    ? { productUrl: mapping.productUrl, productName: mapping.productName, reply: mapping.reply || '' }
    : null;
}

export function addMapping(data, { persist: shouldPersist = true } = {}) {
  const mapping = validateStore({ version: 1, mappings: [data] }).mappings[0];
  if (store.mappings.some((m) => m.mediaId === mapping.mediaId)) {
    throw new Error(`Ya existe un mapping para el mediaId "${mapping.mediaId}".`);
  }
  if (store.mappings.length >= MAX_MAPPINGS) {
    throw new Error(`Máximo ${MAX_MAPPINGS} mappings permitidos.`);
  }
  store.mappings.push(mapping);
  if (shouldPersist) persist(store);
  return structuredClone(mapping);
}

export function updateMapping(mediaId, data, { persist: shouldPersist = true } = {}) {
  const id = String(mediaId ?? '').trim();
  const index = store.mappings.findIndex((m) => m.mediaId === id);
  if (index === -1) {
    throw new Error(`No existe un mapping para el mediaId "${id}".`);
  }
  const updated = validateStore({ version: 1, mappings: [{ ...store.mappings[index], ...data, mediaId: id }] }).mappings[0];
  store.mappings[index] = updated;
  if (shouldPersist) persist(store);
  return structuredClone(updated);
}

export function deleteMapping(mediaId, { persist: shouldPersist = true } = {}) {
  const id = String(mediaId ?? '').trim();
  const index = store.mappings.findIndex((m) => m.mediaId === id);
  if (index === -1) {
    throw new Error(`No existe un mapping para el mediaId "${id}".`);
  }
  const [removed] = store.mappings.splice(index, 1);
  if (shouldPersist) persist(store);
  return structuredClone(removed);
}

export function setMappings(mappings, { persist: shouldPersist = true } = {}) {
  const next = validateStore({ version: 1, mappings });
  if (shouldPersist) persist(next);
  store = next;
  return getMappings();
}

export function resetMappings({ persist: shouldPersist = false } = {}) {
  store = structuredClone(DEFAULTS);
  if (shouldPersist) persist(store);
  return getMappings();
}
