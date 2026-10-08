import mysql from 'mysql2/promise';

let pool = null;

function clean(value) {
  return String(value ?? '').trim();
}

/** Railway may inject MYSQL_URL / DATABASE_URL or discrete MYSQL* vars. */
export function mysqlConfigFromEnv(env = process.env) {
  const url = clean(env.MYSQL_URL || env.DATABASE_URL || env.MYSQL_PRIVATE_URL);
  if (url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname) return null;
      return {
        host: parsed.hostname,
        port: Number(parsed.port || 3306),
        user: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
        database: decodeURIComponent((parsed.pathname || '').replace(/^\//, ''))
      };
    } catch {
      return null;
    }
  }
  const host = clean(env.MYSQLHOST || env.MYSQL_HOST);
  const user = clean(env.MYSQLUSER || env.MYSQL_USER);
  const database = clean(env.MYSQLDATABASE || env.MYSQL_DATABASE);
  if (!host || !user || !database) return null;
  return {
    host,
    port: Number(clean(env.MYSQLPORT || env.MYSQL_PORT) || 3306),
    user,
    password: clean(env.MYSQLPASSWORD || env.MYSQL_PASSWORD),
    database
  };
}

export function isMysqlConfigured(env = process.env) {
  return Boolean(mysqlConfigFromEnv(env));
}

export function storageMode(env = process.env) {
  return isMysqlConfigured(env) ? 'mysql' : 'file';
}

export async function initDb({ seedReplies, seedMedia } = {}) {
  if (!isMysqlConfigured()) {
    console.log('[DB] Sin variables MySQL; persistencia en archivos.');
    return { mode: 'file' };
  }
  const cfg = mysqlConfigFromEnv();
  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 4,
    enableKeepAlive: true
  });

  await createSchema();
  await migrateLegacyBotSettings(seedReplies, seedMedia);

  if (seedReplies != null && !(await hasIntents())) {
    await saveCatalog(seedReplies);
    console.log('[DB] Seed inicial: intents');
  }
  if (seedMedia != null && !(await hasMediaProducts())) {
    await saveMappings(seedMedia.mappings || []);
    console.log('[DB] Seed inicial: media_products');
  }

  console.log(`[DB] MySQL listo (${cfg.host}/${cfg.database})`);
  return { mode: 'mysql' };
}

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_extras (
      id TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
      private_comment_notice VARCHAR(400) NOT NULL,
      private_reply_suffix VARCHAR(200) NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_notices (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      notice_text VARCHAR(400) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intents (
      id VARCHAR(40) NOT NULL PRIMARY KEY,
      label VARCHAR(60) NOT NULL,
      description VARCHAR(180) NOT NULL DEFAULT '',
      handoff TINYINT(1) NOT NULL DEFAULT 0,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      dm TEXT NOT NULL,
      comment_text VARCHAR(400) NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0
    )
  `);
  await ensureColumn('intents', 'enabled', 'TINYINT(1) NOT NULL DEFAULT 1');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intent_keywords (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      intent_id VARCHAR(40) NOT NULL,
      keyword VARCHAR(80) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      INDEX idx_intent_keywords_intent (intent_id),
      CONSTRAINT fk_intent_keywords_intent
        FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_products (
      media_id VARCHAR(25) NOT NULL PRIMARY KEY,
      product_url VARCHAR(500) NOT NULL,
      product_name VARCHAR(120) NOT NULL,
      reply TEXT NOT NULL,
      comment_text VARCHAR(400) NOT NULL DEFAULT '',
      enabled TINYINT(1) NOT NULL DEFAULT 1
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_product_replies (
      media_id VARCHAR(25) NOT NULL,
      intent_id VARCHAR(40) NOT NULL,
      comment_text VARCHAR(400) NOT NULL DEFAULT '',
      dm TEXT NOT NULL,
      PRIMARY KEY (media_id, intent_id),
      CONSTRAINT fk_media_replies_media
        FOREIGN KEY (media_id) REFERENCES media_products(media_id) ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ignored_media (
      media_id VARCHAR(25) NOT NULL PRIMARY KEY,
      note VARCHAR(160) NOT NULL DEFAULT ''
    )
  `);
}

async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length) return;
  await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  console.log(`[DB] Columna ${table}.${column} agregada`);
}

/** One-shot: copy old bot_settings JSON into relational tables if present. */
async function migrateLegacyBotSettings(seedReplies, seedMedia) {
  try {
    const [tables] = await pool.query(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bot_settings'`
    );
    if (!tables.length) return;
    if (await hasIntents()) return;

    const [rows] = await pool.query(
      'SELECT setting_key, payload FROM bot_settings'
    );
    for (const row of rows) {
      const raw = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (row.setting_key === 'replies' && raw?.intents) {
        await saveCatalog(raw);
        console.log('[DB] Migrado bot_settings.replies → tablas');
      }
      if (row.setting_key === 'media-products' && Array.isArray(raw?.mappings)) {
        await saveMappings(raw.mappings);
        console.log('[DB] Migrado bot_settings.media-products → tablas');
      }
    }
    await pool.query('DROP TABLE IF EXISTS bot_settings');
    console.log('[DB] Eliminada tabla legacy bot_settings');
  } catch (err) {
    console.error('[DB] Migración legacy omitida:', err.message);
  }
}

async function hasIntents() {
  const [rows] = await pool.query('SELECT id FROM intents LIMIT 1');
  return rows.length > 0;
}

async function hasMediaProducts() {
  const [rows] = await pool.query('SELECT media_id FROM media_products LIMIT 1');
  return rows.length > 0;
}

export async function loadCatalog() {
  if (!pool) return null;
  const [intentRows] = await pool.query(
    `SELECT id, label, description, handoff, enabled, dm, comment_text AS comment, sort_order
     FROM intents ORDER BY sort_order ASC, id ASC`
  );
  if (!intentRows.length) return null;

  const [keywordRows] = await pool.query(
    `SELECT intent_id, keyword FROM intent_keywords ORDER BY sort_order ASC, id ASC`
  );
  const keywordsByIntent = new Map();
  for (const row of keywordRows) {
    if (!keywordsByIntent.has(row.intent_id)) keywordsByIntent.set(row.intent_id, []);
    keywordsByIntent.get(row.intent_id).push(row.keyword);
  }

  const [extrasRows] = await pool.query(
    `SELECT private_comment_notice, private_reply_suffix FROM bot_extras WHERE id = 1 LIMIT 1`
  );
  const [noticeRows] = await pool.query(
    `SELECT notice_text FROM bot_notices ORDER BY sort_order ASC, id ASC`
  );
  const notices = noticeRows.map((r) => r.notice_text);
  const extras = extrasRows[0] || {};
  const primary = extras.private_comment_notice || notices[0] || '';

  return {
    version: 1,
    extras: {
      privateCommentNotice: primary,
      privateCommentNotices: notices.length ? notices : (primary ? [primary] : []),
      privateReplySuffix: extras.private_reply_suffix || ''
    },
    intents: intentRows.map((row) => ({
      id: row.id,
      label: row.label,
      description: row.description || '',
      handoff: Boolean(row.handoff),
      enabled: row.enabled !== 0 && row.enabled !== false,
      keywords: keywordsByIntent.get(row.id) || [],
      dm: row.dm || '',
      comment: row.comment || ''
    }))
  };
}

export async function saveCatalog(catalog) {
  if (!pool) throw new Error('MySQL no inicializado');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM intent_keywords');
    await conn.query('DELETE FROM intents');
    await conn.query('DELETE FROM bot_notices');
    await conn.query('DELETE FROM bot_extras');

    const extras = catalog.extras || {};
    await conn.query(
      `INSERT INTO bot_extras (id, private_comment_notice, private_reply_suffix)
       VALUES (1, ?, ?)`,
      [
        extras.privateCommentNotice || '',
        extras.privateReplySuffix || ''
      ]
    );
    const notices = Array.isArray(extras.privateCommentNotices)
      ? extras.privateCommentNotices
      : [];
    for (let i = 0; i < notices.length; i++) {
      await conn.query(
        `INSERT INTO bot_notices (notice_text, sort_order) VALUES (?, ?)`,
        [notices[i], i]
      );
    }

    for (let i = 0; i < catalog.intents.length; i++) {
      const intent = catalog.intents[i];
      await conn.query(
        `INSERT INTO intents (id, label, description, handoff, enabled, dm, comment_text, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          intent.id,
          intent.label,
          intent.description || '',
          intent.handoff ? 1 : 0,
          intent.enabled === false ? 0 : 1,
          intent.dm || '',
          intent.comment || '',
          i
        ]
      );
      const keywords = Array.isArray(intent.keywords) ? intent.keywords : [];
      for (let k = 0; k < keywords.length; k++) {
        await conn.query(
          `INSERT INTO intent_keywords (intent_id, keyword, sort_order) VALUES (?, ?, ?)`,
          [intent.id, keywords[k], k]
        );
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function loadMappings() {
  if (!pool) return null;
  const [rows] = await pool.query(
    `SELECT media_id AS mediaId, product_url AS productUrl, product_name AS productName,
            reply, comment_text AS comment, enabled
     FROM media_products ORDER BY media_id ASC`
  );
  if (!rows.length) return [];

  const [replyRows] = await pool.query(
    `SELECT media_id, intent_id, comment_text AS comment, dm FROM media_product_replies`
  );
  const repliesByMedia = new Map();
  for (const row of replyRows) {
    if (!repliesByMedia.has(row.media_id)) repliesByMedia.set(row.media_id, {});
    repliesByMedia.get(row.media_id)[row.intent_id] = {
      comment: row.comment || '',
      dm: row.dm || ''
    };
  }

  return rows.map((row) => ({
    mediaId: row.mediaId,
    productUrl: row.productUrl,
    productName: row.productName,
    reply: row.reply || '',
    comment: row.comment || '',
    replies: repliesByMedia.get(row.mediaId) || {},
    enabled: Boolean(row.enabled)
  }));
}

export async function saveMappings(mappings) {
  if (!pool) throw new Error('MySQL no inicializado');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM media_product_replies');
    await conn.query('DELETE FROM media_products');
    for (const mapping of mappings) {
      await insertMapping(conn, mapping);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function insertMapping(conn, mapping) {
  await conn.query(
    `INSERT INTO media_products (media_id, product_url, product_name, reply, comment_text, enabled)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      mapping.mediaId,
      mapping.productUrl,
      mapping.productName,
      mapping.reply || '',
      mapping.comment || '',
      mapping.enabled === false ? 0 : 1
    ]
  );
  const replies = mapping.replies && typeof mapping.replies === 'object' ? mapping.replies : {};
  for (const [intentId, value] of Object.entries(replies)) {
    await conn.query(
      `INSERT INTO media_product_replies (media_id, intent_id, comment_text, dm)
       VALUES (?, ?, ?, ?)`,
      [mapping.mediaId, intentId, value.comment || '', value.dm || '']
    );
  }
}

export async function insertMediaMapping(mapping) {
  if (!pool) throw new Error('MySQL no inicializado');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await insertMapping(conn, mapping);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function updateMediaMapping(mediaId, mapping) {
  if (!pool) throw new Error('MySQL no inicializado');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM media_product_replies WHERE media_id = ?', [mediaId]);
    await conn.query('DELETE FROM media_products WHERE media_id = ?', [mediaId]);
    await insertMapping(conn, mapping);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function deleteMediaMapping(mediaId) {
  if (!pool) throw new Error('MySQL no inicializado');
  await pool.query('DELETE FROM media_products WHERE media_id = ?', [mediaId]);
}

export async function loadIgnoredMedia() {
  if (!pool) return null;
  const [rows] = await pool.query(
    `SELECT media_id AS mediaId, note FROM ignored_media ORDER BY media_id ASC`
  );
  return rows.map((row) => {
    const note = String(row.note || '').trim();
    return note ? { mediaId: row.mediaId, note } : { mediaId: row.mediaId };
  });
}

export async function saveIgnoredMedia(mediaIds) {
  if (!pool) throw new Error('MySQL no inicializado');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM ignored_media');
    for (const item of mediaIds) {
      await conn.query(
        `INSERT INTO ignored_media (media_id, note) VALUES (?, ?)`,
        [item.mediaId, item.note || '']
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function insertIgnoredMedia(item) {
  if (!pool) throw new Error('MySQL no inicializado');
  await pool.query(
    `INSERT INTO ignored_media (media_id, note) VALUES (?, ?)`,
    [item.mediaId, item.note || '']
  );
}

export async function deleteIgnoredMedia(mediaId) {
  if (!pool) throw new Error('MySQL no inicializado');
  await pool.query('DELETE FROM ignored_media WHERE media_id = ?', [mediaId]);
}

export async function closeDb() {
  if (!pool) return;
  await pool.end();
  pool = null;
}
