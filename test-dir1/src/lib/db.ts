import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export type Content = {
  id: number;
  title: string;
  body: string;
  createdAt: number;
};

type Db = InstanceType<typeof Database>;

let db: Db | null = null;

export function getDbPath(): string {
  return process.env.SQLITE_DB_PATH ?? path.resolve(process.cwd(), 'data', 'app.db');
}

export function getDb(): Db {
  if (db) return db;

  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );

    -- Rebuild the FTS index on startup so the tokenizer configuration stays
    -- in sync with the application code. This is acceptable for the MVP data
    -- volume and avoids fragile schema-version checks.
    DROP TABLE IF EXISTS content_fts;

    CREATE VIRTUAL TABLE content_fts USING fts5(
      title,
      body,
      content='content',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS content_ai AFTER INSERT ON content BEGIN
      INSERT INTO content_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS content_ad AFTER DELETE ON content BEGIN
      INSERT INTO content_fts(content_fts, rowid, title, body)
      VALUES ('delete', old.id, old.title, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS content_au AFTER UPDATE ON content BEGIN
      INSERT INTO content_fts(content_fts, rowid, title, body)
      VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO content_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
    END;

    INSERT INTO content_fts(rowid, title, body) SELECT id, title, body FROM content;
  `);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function storeContent(title: string, body: string): number {
  const stmt = getDb().prepare(
    'INSERT INTO content (title, body, createdAt) VALUES (?, ?, ?)'
  );
  const info = stmt.run(title, body, Date.now());
  return Number(info.lastInsertRowid);
}

export function getContentById(id: number): Content | undefined {
  const stmt = getDb().prepare<[number], Content>('SELECT * FROM content WHERE id = ?');
  return stmt.get(id);
}

export function getAllContent(): Content[] {
  const stmt = getDb().prepare<[], Content>('SELECT * FROM content ORDER BY createdAt DESC, id DESC');
  return stmt.all();
}

export function searchByKeyword(query: string): Content[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const stmt = getDb().prepare<[string], Content>(`
    SELECT c.* FROM content c
    JOIN content_fts f ON c.id = f.rowid
    WHERE content_fts MATCH ?
    ORDER BY rank
  `);
  return stmt.all(trimmed);
}
