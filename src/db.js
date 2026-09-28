import mysql from 'mysql2/promise';

const SETTING_REPLIES = 'replies';
const SETTING_MEDIA = 'media-products';

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      payload JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  if (seedReplies != null) await seedIfMissing(SETTING_REPLIES, seedReplies);
  if (seedMedia != null) await seedIfMissing(SETTING_MEDIA, seedMedia);

  console.log(`[DB] MySQL listo (${cfg.host}/${cfg.database})`);
  return { mode: 'mysql' };
}

async function seedIfMissing(key, payload) {
  const existing = await getSetting(key);
  if (existing != null) return;
  await setSetting(key, payload);
  console.log(`[DB] Seed inicial: ${key}`);
}

export async function getSetting(key) {
  if (!pool) return null;
  const [rows] = await pool.query(
    'SELECT payload FROM bot_settings WHERE setting_key = ? LIMIT 1',
    [key]
  );
  if (!rows.length) return null;
  const raw = rows[0].payload;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function setSetting(key, payload) {
  if (!pool) throw new Error('MySQL no inicializado');
  const json = JSON.stringify(payload);
  await pool.query(
    `INSERT INTO bot_settings (setting_key, payload)
     VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
    [key, json]
  );
}

export async function closeDb() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export const SETTINGS = {
  REPLIES: SETTING_REPLIES,
  MEDIA: SETTING_MEDIA
};
