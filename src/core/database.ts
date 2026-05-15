import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "node:path";
import fs from "node:fs";

export class BrainDB {
  private db: Database.Database;

  constructor(vaultRoot: string) {
    const dataDir = path.join(vaultRoot, ".mcp-server", "data");
    fs.mkdirSync(dataDir, { recursive: true });

    const dbPath = path.join(dataDir, "brain.db");
    this.db = new Database(dbPath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    sqliteVec.load(this.db);

    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        frontmatter TEXT NOT NULL DEFAULT '{}',
        content TEXT NOT NULL DEFAULT '',
        modified_at INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        target_path TEXT NOT NULL,
        target_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
        context TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, target_path)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target_path ON edges(target_path);
      CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
    `);

    const ftsExists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='notes_fts'"
      )
      .get();

    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE notes_fts USING fts5(
          title,
          content,
          content=notes,
          content_rowid=id,
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content)
          VALUES (new.id, new.title, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content)
          VALUES ('delete', old.id, old.title, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content)
          VALUES ('delete', old.id, old.title, old.content);
          INSERT INTO notes_fts(rowid, title, content)
          VALUES (new.id, new.title, new.content);
        END;
      `);
    }

    const vecExists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='notes_vec'"
      )
      .get();

    if (!vecExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE notes_vec USING vec0(
          note_id INTEGER PRIMARY KEY,
          embedding FLOAT[384]
        );
      `);
    }
  }

  upsertNote(
    notePath: string,
    title: string,
    frontmatter: Record<string, unknown>,
    content: string,
    modifiedAt: number
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO notes (path, title, frontmatter, content, modified_at, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        frontmatter = excluded.frontmatter,
        content = excluded.content,
        modified_at = excluded.modified_at,
        indexed_at = excluded.indexed_at
    `);

    const result = stmt.run(
      notePath,
      title,
      JSON.stringify(frontmatter),
      content,
      modifiedAt,
      Date.now()
    );

    return this.getNoteId(notePath)!;
  }

  getNoteId(notePath: string): number | undefined {
    const row = this.db
      .prepare("SELECT id FROM notes WHERE path = ?")
      .get(notePath) as { id: number } | undefined;
    return row?.id;
  }

  getNoteByPath(notePath: string): {
    id: number;
    path: string;
    title: string;
    modified_at: number;
    indexed_at: number;
  } | undefined {
    return this.db
      .prepare("SELECT id, path, title, modified_at, indexed_at FROM notes WHERE path = ?")
      .get(notePath) as any;
  }

  getAllNotePaths(): { path: string; modified_at: number }[] {
    return this.db
      .prepare("SELECT path, modified_at FROM notes")
      .all() as any[];
  }

  deleteNoteByPath(notePath: string): void {
    this.db.prepare("DELETE FROM notes WHERE path = ?").run(notePath);
  }

  upsertEdges(
    sourceId: number,
    links: { targetPath: string; context: string }[]
  ): void {
    this.db
      .prepare("DELETE FROM edges WHERE source_id = ?")
      .run(sourceId);

    const insert = this.db.prepare(
      "INSERT INTO edges (source_id, target_path, target_id, context) VALUES (?, ?, ?, ?)"
    );

    const insertMany = this.db.transaction(
      (edges: { targetPath: string; context: string }[]) => {
        for (const edge of edges) {
          const targetId = this.resolveTargetId(edge.targetPath);
          insert.run(sourceId, edge.targetPath, targetId, edge.context);
        }
      }
    );

    insertMany(links);
  }

  private resolveTargetId(targetPath: string): number | null {
    const candidates = [
      targetPath,
      targetPath + ".md",
      targetPath.replace(/ /g, "-") + ".md",
    ];

    for (const candidate of candidates) {
      const row = this.db
        .prepare("SELECT id FROM notes WHERE path = ? OR path LIKE ?")
        .get(candidate, `%/${candidate}`) as { id: number } | undefined;
      if (row) return row.id;
    }

    return null;
  }

  resolveAllEdges(): void {
    const unresolved = this.db
      .prepare("SELECT rowid, target_path FROM edges WHERE target_id IS NULL")
      .all() as { rowid: number; target_path: string }[];

    const update = this.db.prepare(
      "UPDATE edges SET target_id = ? WHERE rowid = ?"
    );

    for (const edge of unresolved) {
      const targetId = this.resolveTargetId(edge.target_path);
      if (targetId !== null) {
        update.run(targetId, edge.rowid);
      }
    }
  }

  upsertEmbedding(noteId: number, embedding: Float32Array): void {
    const bigId = BigInt(noteId);

    this.db
      .prepare("DELETE FROM notes_vec WHERE note_id = ?")
      .run(bigId);

    this.db
      .prepare("INSERT INTO notes_vec (note_id, embedding) VALUES (?, ?)")
      .run(bigId, Buffer.from(embedding.buffer));
  }

  searchFTS(query: string, limit: number): { id: number; path: string; title: string; rank: number }[] {
    return this.db
      .prepare(
        `SELECT n.id, n.path, n.title, rank
         FROM notes_fts
         JOIN notes n ON n.id = notes_fts.rowid
         WHERE notes_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, limit) as any[];
  }

  searchVector(embedding: Float32Array, limit: number): { note_id: number; distance: number }[] {
    const rows = this.db
      .prepare(
        `SELECT note_id, distance
         FROM notes_vec
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(Buffer.from(embedding.buffer), limit) as { note_id: bigint | number; distance: number }[];

    return rows.map((r) => ({
      note_id: Number(r.note_id),
      distance: r.distance,
    }));
  }

  getNotePath(noteId: number): string | undefined {
    const row = this.db
      .prepare("SELECT path FROM notes WHERE id = ?")
      .get(noteId) as { path: string } | undefined;
    return row?.path;
  }

  getNoteTitle(noteId: number): string | undefined {
    const row = this.db
      .prepare("SELECT title FROM notes WHERE id = ?")
      .get(noteId) as { title: string } | undefined;
    return row?.title;
  }

  getSnippet(noteId: number, maxLen = 200): string {
    const row = this.db
      .prepare("SELECT content FROM notes WHERE id = ?")
      .get(noteId) as { content: string } | undefined;
    if (!row) return "";
    return row.content.slice(0, maxLen).replace(/\n/g, " ").trim();
  }

  getOutlinks(noteId: number): { target_path: string; target_id: number | null }[] {
    return this.db
      .prepare("SELECT target_path, target_id FROM edges WHERE source_id = ?")
      .all(noteId) as any[];
  }

  getBacklinks(noteId: number): { source_id: number; context: string }[] {
    return this.db
      .prepare("SELECT source_id, context FROM edges WHERE target_id = ?")
      .all(noteId) as any[];
  }

  getAllEdges(): { source_id: number; target_id: number }[] {
    return this.db
      .prepare(
        "SELECT source_id, target_id FROM edges WHERE target_id IS NOT NULL"
      )
      .all() as any[];
  }

  getAllNoteIds(): number[] {
    return (
      this.db.prepare("SELECT id FROM notes").all() as { id: number }[]
    ).map((r) => r.id);
  }

  getNoteCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) as count FROM notes").get() as {
        count: number;
      }
    ).count;
  }

  getEdgeCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) as count FROM edges").get() as {
        count: number;
      }
    ).count;
  }

  close(): void {
    this.db.close();
  }
}
