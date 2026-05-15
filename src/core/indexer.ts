import fs from "node:fs";
import path from "node:path";
import type { BrainDB } from "./database.js";
import type { Vault } from "./vault.js";
import { embed, chunkByHeadings } from "./embedder.js";
import type { GraphEngine } from "./graph-engine.js";

const SKIP_DIRS = new Set([
  ".obsidian",
  ".mcp-server",
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  ".next",
  "Archive",
  ".pytest_cache",
  ".claude",
  ".github",
  ".vscode",
  "build",
  "secrets",
  ".agents",
  "mlruns",
  "artifacts",
  ".ipynb_checkpoints",
]);

export class Indexer {
  constructor(
    private readonly vaultRoot: string,
    private readonly db: BrainDB,
    private readonly vault: Vault,
    private readonly graph: GraphEngine
  ) {}

  async fullReindex(): Promise<{ indexed: number; removed: number }> {
    const allFiles = this.scanVault();
    let indexed = 0;

    const existingPaths = new Set(
      this.db.getAllNotePaths().map((n) => n.path)
    );

    for (const filePath of allFiles) {
      const relativePath = path.relative(this.vaultRoot, filePath);
      existingPaths.delete(relativePath);

      try {
        await this.indexFile(relativePath);
        indexed++;

        if (indexed % 50 === 0) {
          process.stderr.write(`Indexed ${indexed}/${allFiles.length} notes\n`);
        }
      } catch (err) {
        process.stderr.write(
          `Error indexing ${relativePath}: ${err}\n`
        );
      }
    }

    let removed = 0;
    for (const stale of existingPaths) {
      this.db.deleteNoteByPath(stale);
      removed++;
    }

    this.db.resolveAllEdges();
    this.graph.rebuild();

    return { indexed, removed };
  }

  async incrementalIndex(changedPaths: string[]): Promise<number> {
    let indexed = 0;

    for (const filePath of changedPaths) {
      const resolved = path.resolve(this.vaultRoot, filePath);

      if (!fs.existsSync(resolved)) {
        this.db.deleteNoteByPath(filePath);
        continue;
      }

      try {
        await this.indexFile(filePath);
        indexed++;
      } catch (err) {
        process.stderr.write(
          `Error indexing ${filePath}: ${err}\n`
        );
      }
    }

    this.db.resolveAllEdges();
    this.graph.rebuild();

    return indexed;
  }

  needsReindex(): string[] {
    const allFiles = this.scanVault();
    const stale: string[] = [];

    for (const filePath of allFiles) {
      const relativePath = path.relative(this.vaultRoot, filePath);
      const stat = fs.statSync(filePath);
      const fileModified = Math.floor(stat.mtimeMs);

      const existing = this.db.getNoteByPath(relativePath);
      if (!existing || existing.modified_at < fileModified) {
        stale.push(relativePath);
      }
    }

    return stale;
  }

  private async indexFile(relativePath: string): Promise<void> {
    const note = this.vault.readNote(relativePath);

    const noteId = this.db.upsertNote(
      note.path,
      note.title,
      note.frontmatter,
      note.content,
      note.modifiedAt
    );

    const edges = note.links.map((link) => ({
      targetPath: link,
      context: this.getContextForLink(note.content, link),
    }));
    this.db.upsertEdges(noteId, edges);

    const textForEmbedding = `${note.title}\n\n${note.content}`;
    const chunks = chunkByHeadings(textForEmbedding);
    const fullText = chunks.join("\n\n").slice(0, 2000);

    try {
      const embedding = await embed(fullText);
      this.db.upsertEmbedding(noteId, embedding);
    } catch (err) {
      process.stderr.write(
        `Embedding failed for ${relativePath}: ${err}\n`
      );
    }
  }

  private getContextForLink(
    content: string,
    link: string
  ): string {
    const index = content.indexOf(`[[${link}`);
    if (index === -1) return "";

    const start = Math.max(0, index - 80);
    const end = Math.min(content.length, index + link.length + 80);
    return content.slice(start, end).replace(/\n/g, " ").trim();
  }

  private scanVault(): string[] {
    const files: string[] = [];
    this.walkDir(this.vaultRoot, files);
    return files;
  }

  private walkDir(dir: string, results: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            this.walkDir(fullPath, results);
          }
        } catch {
          // broken symlink or permission error
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
          results.push(fullPath);
        }
      }
    }
  }
}
