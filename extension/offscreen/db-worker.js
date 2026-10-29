// SQLite (WASM) worker. The database file lives in the extension's
// Origin Private File System via the opfs-sahpool VFS.
import sqlite3InitModule from '../vendor/sqlite/sqlite3.mjs';

const DB_FILE = '/linkedin-feed.sqlite3';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS posts (
  id               TEXT PRIMARY KEY,  -- LinkedIn feed card key
  url              TEXT,
  author_name      TEXT,
  author_headline  TEXT,
  author_url       TEXT,
  context          TEXT,              -- e.g. "Jane Doe likes this"
  posted_label     TEXT,              -- e.g. "3d"
  posted_at_est    TEXT,              -- ISO time estimated from posted_label
  text             TEXT,
  reactions        INTEGER,
  comments         INTEGER,
  reposts          INTEGER,
  has_video        INTEGER NOT NULL DEFAULT 0,
  is_repost        INTEGER NOT NULL DEFAULT 0,
  orig_author_name TEXT,
  orig_author_url  TEXT,
  orig_text        TEXT,
  raw_text         TEXT,              -- full visible text of the card, for re-parsing later
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  sha256 TEXT PRIMARY KEY,
  mime   TEXT,
  width  INTEGER,
  height INTEGER,
  bytes  BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS post_images (
  post_id  TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  sha256   TEXT NOT NULL REFERENCES images(sha256),
  src_url  TEXT,
  PRIMARY KEY (post_id, position)
);
CREATE INDEX IF NOT EXISTS posts_first_seen ON posts(first_seen);
`;

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'linkedin-collector' });
  const db = new pool.OpfsSAHPoolDb(DB_FILE);
  db.exec(SCHEMA);
  return { sqlite3, pool, db };
})();

const ops = {
  has({ id }, { db }) {
    return db.selectValue('SELECT 1 FROM posts WHERE id = ?', [id]) === 1;
  },

  // A post seen again: refresh what we extracted (newest parser wins), keep first_seen and images.
  touch({ post }, { db }) {
    db.exec({
      sql: `UPDATE posts SET author_name = coalesce(?, author_name), author_headline = coalesce(?, author_headline),
              author_url = coalesce(?, author_url), context = coalesce(?, context), text = coalesce(?, text),
              reactions = coalesce(?, reactions), comments = coalesce(?, comments), reposts = coalesce(?, reposts),
              is_repost = ?, orig_author_name = coalesce(?, orig_author_name),
              orig_author_url = coalesce(?, orig_author_url), orig_text = coalesce(?, orig_text),
              raw_text = ?, last_seen = ? WHERE id = ?`,
      bind: [post.authorName, post.authorHeadline, post.authorUrl, post.context, post.text,
             post.reactions, post.comments, post.reposts, post.isRepost ? 1 : 0, post.origAuthorName,
             post.origAuthorUrl, post.origText, post.rawText, post.collectedAt, post.id],
    });
  },

  save({ post, images }, { db }) {
    db.transaction(() => {
      db.exec({
        sql: `INSERT INTO posts (id, url, author_name, author_headline, author_url, context,
                posted_label, posted_at_est, text, reactions, comments, reposts, has_video,
                is_repost, orig_author_name, orig_author_url, orig_text, raw_text, first_seen, last_seen)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET reactions = excluded.reactions,
                comments = excluded.comments, reposts = excluded.reposts, last_seen = excluded.last_seen`,
        bind: [post.id, post.url, post.authorName, post.authorHeadline, post.authorUrl, post.context,
               post.postedLabel, post.postedAtEst, post.text, post.reactions, post.comments, post.reposts,
               post.hasVideo ? 1 : 0, post.isRepost ? 1 : 0, post.origAuthorName, post.origAuthorUrl,
               post.origText, post.rawText, post.collectedAt, post.collectedAt],
      });
      images.forEach((img, position) => {
        db.exec({
          sql: 'INSERT OR IGNORE INTO images (sha256, mime, width, height, bytes) VALUES (?,?,?,?,?)',
          bind: [img.sha256, img.mime, img.width, img.height, new Uint8Array(img.bytes)],
        });
        db.exec({
          sql: 'INSERT OR REPLACE INTO post_images (post_id, position, sha256, src_url) VALUES (?,?,?,?)',
          bind: [post.id, position, img.sha256, img.src],
        });
      });
    });
  },

  stats(_args, { db, pool }) {
    return {
      posts: db.selectValue('SELECT count(*) FROM posts'),
      images: db.selectValue('SELECT count(*) FROM images'),
      bytes: db.selectValue('SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()'),
      file: DB_FILE,
      vfsFiles: pool.getFileNames(),
    };
  },

  recent({ limit }, { db }) {
    return db.selectObjects(
      `SELECT rowid AS n, id, author_name, posted_label, substr(text, 1, 140) AS text, reactions, comments, reposts,
              (SELECT count(*) FROM post_images pi WHERE pi.post_id = posts.id) AS images, first_seen
       FROM posts ORDER BY rowid DESC LIMIT ?`, [limit]);
  },

  clear(_args, { db }) {
    db.transaction(() => db.exec('DELETE FROM post_images; DELETE FROM images; DELETE FROM posts;'));
    db.exec('VACUUM');
  },

  export(_args, { pool }) {
    return pool.exportFile(DB_FILE);
  },
};

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    const ctx = await ready;
    if (!ops[op]) throw new Error(`unknown op ${op}`);
    const result = await ops[op](args ?? {}, ctx);
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
