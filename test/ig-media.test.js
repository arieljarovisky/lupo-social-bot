import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaQuery, cleanCursor, listInstagramMedia } from '../src/ig-media.js';

const cfg = { igUserId: 'ig123', igAccessToken: 'TOKEN', apiVersion: 'v26.0' };

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

test('acepta link de post, reel o un ID numérico', () => {
  assert.deepEqual(parseMediaQuery('https://www.instagram.com/p/AbCdEf12/?img_index=1'), { shortcode: 'AbCdEf12' });
  assert.deepEqual(parseMediaQuery('https://instagram.com/reel/ZzYyXx9/'), { shortcode: 'ZzYyXx9' });
  assert.deepEqual(parseMediaQuery('17900000000000001'), { mediaId: '17900000000000001' });
  assert.equal(parseMediaQuery('https://example.com/p/AbCdEf12'), null);
  assert.throws(() => cleanCursor('https://evil.test/?after=1'), /cursor/);
});

test('lista publicaciones recientes y no manda el token en la URL', async () => {
  let called;
  const fetchFn = async (url, opts) => {
    called = { url, opts };
    return jsonResponse({
      data: [{
        id: '17900000000000001',
        caption: 'Boxer negro',
        media_type: 'IMAGE',
        permalink: 'https://www.instagram.com/p/AbCdEf12/',
        timestamp: '2026-09-01T12:00:00+0000',
        thumbnail_url: 'https://scontent.cdninstagram.com/v/thumb.jpg'
      }],
      paging: { cursors: { after: 'CURSOR1' }, next: 'https://graph.instagram.com/next' }
    });
  };
  const result = await listInstagramMedia(cfg, { fetchFn });
  assert.equal(result.media[0].id, '17900000000000001');
  assert.equal(result.media[0].caption, 'Boxer negro');
  assert.equal(result.after, 'CURSOR1');
  assert.match(called.url, /^https:\/\/graph\.instagram\.com\/v26\.0\/ig123\/media\?/);
  assert.equal(called.opts.headers.Authorization, 'Bearer TOKEN');
  assert.doesNotMatch(called.url, /TOKEN/);
});

test('encuentra el ID a partir del link de la publicación', async () => {
  const pages = [
    { data: [{ id: '11111111111111111', permalink: 'https://www.instagram.com/p/OtraPub/' }], paging: { cursors: { after: 'N2' }, next: 'https://graph.instagram.com/next' } },
    { data: [{ id: '17900000000000009', permalink: 'https://www.instagram.com/reel/MiReel01/', media_type: 'VIDEO', caption: 'Reel' }] }
  ];
  const fetchFn = async () => jsonResponse(pages.shift());
  const result = await listInstagramMedia(cfg, { q: 'https://www.instagram.com/reel/MiReel01/', fetchFn });
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].id, '17900000000000009');
  assert.equal(result.after, '');
});

test('un ID numérico se consulta directo', async () => {
  let called;
  const fetchFn = async (url) => {
    called = url;
    return jsonResponse({ id: '17900000000000001', permalink: 'https://www.instagram.com/p/AbCdEf12/', media_type: 'IMAGE' });
  };
  const result = await listInstagramMedia(cfg, { q: '17900000000000001', fetchFn });
  assert.equal(result.media[0].id, '17900000000000001');
  assert.match(called, /\/17900000000000001\?/);
});
