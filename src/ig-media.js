import { graphGet } from './meta.js';

const FIELDS = 'id,caption,media_type,permalink,timestamp,thumbnail_url';
const PAGE_SIZE = 25;
const MAX_PAGES = 6;

function idList(value) {
  return String(value ?? '').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function readableGraphError(err) {
  const match = String(err?.message || '').match(/"message":"([^"]+)"/);
  if (match) return `Instagram no devolvió las publicaciones: ${match[1]}`;
  return 'No se pudieron leer las publicaciones de Instagram.';
}

export function parseMediaQuery(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d{10,25}$/.test(text)) return { mediaId: text };
  let href = text;
  if (!/^https?:\/\//i.test(href) && /instagram\.com/i.test(href)) href = `https://${href}`;
  let parsed;
  try { parsed = new URL(href); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!/(^|\.)instagram\.com$/i.test(parsed.hostname)) return null;
  const match = parsed.pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,30})\/?$/);
  if (!match) return null;
  return { shortcode: match[1] };
}

export function cleanCursor(value) {
  const cursor = String(value ?? '').trim();
  if (!cursor) return '';
  if (cursor.length > 800 || /[\s&#?/\\]/.test(cursor)) throw new Error('El cursor de paginación no es válido.');
  return cursor;
}

export function normalizeMedia(item) {
  if (!item?.id) return null;
  return {
    id: String(item.id),
    caption: String(item.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    mediaType: String(item.media_type ?? ''),
    permalink: String(item.permalink ?? ''),
    timestamp: String(item.timestamp ?? ''),
    thumbnailUrl: String(item.thumbnail_url ?? '')
  };
}

function permalinkHasShortcode(permalink, shortcode) {
  try {
    return new URL(permalink).pathname.split('/').includes(shortcode);
  } catch {
    return false;
  }
}

async function fetchPage({ igUserId, token, version, after, fetchFn }) {
  const data = await graphGet({
    platform: 'instagram',
    path: `${igUserId}/media`,
    query: { fields: FIELDS, limit: PAGE_SIZE, after },
    token,
    version,
    fetchFn
  });
  const media = (data.data ?? []).map(normalizeMedia).filter(Boolean);
  const next = data.paging?.cursors?.after && data.paging?.next ? String(data.paging.cursors.after) : '';
  return { media, after: next };
}

async function fetchById({ mediaId, token, version, fetchFn }) {
  const data = await graphGet({
    platform: 'instagram',
    path: mediaId,
    query: { fields: FIELDS },
    token,
    version,
    fetchFn
  });
  const media = normalizeMedia(data);
  if (!media) throw new Error('Instagram no devolvió esa publicación.');
  return { media: [media], after: '' };
}

export async function listInstagramMedia(config, { q = '', after = '', fetchFn = fetch } = {}) {
  const ids = idList(config?.igUserId);
  const token = config?.igAccessToken || '';
  if (!ids.length || !token) throw new Error('Faltan IG_USER_ID o IG_ACCESS_TOKEN para leer las publicaciones.');
  const version = config?.apiVersion || 'v26.0';
  const query = String(q ?? '').trim();
  const cursor = cleanCursor(after);
  if (query) {
    const parsed = parseMediaQuery(query);
    if (!parsed) throw new Error('Pegá el link de un post, reel o video de Instagram, o el ID numérico.');
    if (parsed.mediaId) {
      try {
        return await fetchById({ mediaId: parsed.mediaId, token, version, fetchFn });
      } catch (err) {
        throw new Error(readableGraphError(err));
      }
    }
    let lastError;
    let scanned = false;
    for (const igUserId of ids) {
      let pageAfter = '';
      for (let page = 0; page < MAX_PAGES; page++) {
        let result;
        try {
          result = await fetchPage({ igUserId, token, version, after: pageAfter, fetchFn });
        } catch (err) {
          lastError = err;
          break;
        }
        scanned = true;
        const found = result.media.find((item) => permalinkHasShortcode(item.permalink, parsed.shortcode));
        if (found) return { media: [found], after: '' };
        if (!result.after) break;
        pageAfter = result.after;
      }
    }
    if (!scanned && lastError) throw new Error(readableGraphError(lastError));
    throw new Error('No encontré esa publicación entre las últimas. Probá con Ver recientes.');
  }
  let lastError;
  for (const igUserId of ids) {
    try {
      return await fetchPage({ igUserId, token, version, after: cursor, fetchFn });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(readableGraphError(lastError));
}
