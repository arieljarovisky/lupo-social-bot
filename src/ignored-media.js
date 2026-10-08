import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataFile } from './data-dir.js';
import {
  deleteIgnoredMedia,
  insertIgnoredMedia,
  isMysqlConfigured,
  loadIgnoredMedia,
  saveIgnoredMedia
} from './db.js';

const DATA_PATH = dataFile('ignored-media.json');
const MEDIA_ID_RE = /^\d{10,25}$/;
const MAX_IGNORED = 500;
const MAX_NOTE = 160;

const DEFAULTS = { version: 1, mediaIds: [] };

let store = loadFromDisk();

function loadFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    return validateStore(raw);
  } catch (err) {
    console.error('[IGNORED-MEDIA] No se pudo leer data/ignored-media.json, uso valores por defecto:', err.message);
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
    await saveIgnoredMedia(next.mediaIds);
    return;
  }
  persistFile(next);
}

export function defaultIgnoredStore() {
  return structuredClone(DEFAULTS);
}

/** Reload ignored media from MySQL after initDb. No-op in file mode. */
export async function hydrateIgnoredMedia() {
  if (!isMysqlConfigured()) return getIgnoredMedia();
  const stored = await loadIgnoredMedia();
  if (stored == null) {
    store = structuredClone(DEFAULTS);
    return getIgnoredMedia();
  }
  try {
    store = validateStore({ version: 1, mediaIds: stored });
  } catch (err) {
    console.error('[IGNORED-MEDIA] Datos MySQL inválidos, uso defaults:', err.message);
    store = structuredClone(DEFAULTS);
  }
  return getIgnoredMedia();
}

export function validateStore(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.mediaIds)) {
    throw new Error('El archivo debe incluir una lista de mediaIds.');
  }
  if (input.mediaIds.length > MAX_IGNORED) {
    throw new Error(`Máximo ${MAX_IGNORED} publicaciones ignoradas.`);
  }
  const seen = new Set();
  const mediaIds = input.mediaIds.map((raw, index) => {
    const item = typeof raw === 'string' || typeof raw === 'number'
      ? { mediaId: raw }
      : (raw && typeof raw === 'object' ? raw : null);
    if (!item) throw new Error(`Entrada inválida en la posición ${index + 1}.`);
    const mediaId = String(item.mediaId ?? '').trim();
    if (!MEDIA_ID_RE.test(mediaId)) {
      throw new Error(`El mediaId "${mediaId || '(vacío)'}" no es válido (posición ${index + 1}).`);
    }
    if (seen.has(mediaId)) {
      throw new Error(`Hay dos entradas con el mismo mediaId "${mediaId}".`);
    }
    seen.add(mediaId);
    const note = String(item.note ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
    return note ? { mediaId, note } : { mediaId };
  });
  return { version: 1, mediaIds };
}

export function getIgnoredMedia() {
  return structuredClone(store.mediaIds);
}

export function isMediaIgnored(mediaId) {
  if (!mediaId) return false;
  const id = String(mediaId).trim();
  return store.mediaIds.some((item) => item.mediaId === id);
}

export async function ignoreMedia(data, { persist: shouldPersist = true } = {}) {
  const entry = validateStore({ version: 1, mediaIds: [data] }).mediaIds[0];
  if (store.mediaIds.some((item) => item.mediaId === entry.mediaId)) {
    throw new Error(`Esa publicación ya está en la lista de ignoradas.`);
  }
  if (store.mediaIds.length >= MAX_IGNORED) {
    throw new Error(`Máximo ${MAX_IGNORED} publicaciones ignoradas.`);
  }
  store.mediaIds.push(entry);
  if (shouldPersist) {
    if (isMysqlConfigured()) await insertIgnoredMedia(entry);
    else persistFile(store);
  }
  return structuredClone(entry);
}

export async function unignoreMedia(mediaId, { persist: shouldPersist = true } = {}) {
  const id = String(mediaId ?? '').trim();
  const index = store.mediaIds.findIndex((item) => item.mediaId === id);
  if (index === -1) {
    throw new Error(`No hay una publicación ignorada con el mediaId "${id}".`);
  }
  const [removed] = store.mediaIds.splice(index, 1);
  if (shouldPersist) {
    if (isMysqlConfigured()) await deleteIgnoredMedia(id);
    else persistFile(store);
  }
  return structuredClone(removed);
}

export async function setIgnoredMedia(mediaIds, { persist: shouldPersist = true } = {}) {
  const next = validateStore({ version: 1, mediaIds });
  store = next;
  if (shouldPersist) await persist(next);
  return getIgnoredMedia();
}

export async function resetIgnoredMedia({ persist: shouldPersist = false } = {}) {
  store = structuredClone(DEFAULTS);
  if (shouldPersist) await persist(store);
  return getIgnoredMedia();
}
