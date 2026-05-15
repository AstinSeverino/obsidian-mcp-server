import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  validatePath,
  validateExtension,
  sanitizeFrontmatter,
} from "./security.js";
import type { Note, NoteFrontmatter } from "../types.js";

const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export class Vault {
  constructor(private readonly root: string) {}

  readNote(notePath: string): Note {
    const resolved = validatePath(notePath, this.root);
    validateExtension(resolved);

    const raw = fs.readFileSync(resolved, "utf-8");
    const { data, content } = matter(raw);
    const frontmatter = sanitizeFrontmatter(data) as NoteFrontmatter;
    const links = this.extractLinks(content);
    const stat = fs.statSync(resolved);
    const title =
      frontmatter.title ??
      path.basename(resolved, path.extname(resolved));

    return {
      path: path.relative(this.root, resolved),
      title: String(title),
      frontmatter,
      content,
      links,
      modifiedAt: Math.floor(stat.mtimeMs),
    };
  }

  writeNote(
    notePath: string,
    title: string,
    content: string,
    tags?: string[]
  ): string {
    const resolved = validatePath(notePath, this.root);
    validateExtension(resolved);

    if (fs.existsSync(resolved)) {
      throw new Error(`Note already exists: ${notePath}. Use updateNote instead.`);
    }

    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });

    const frontmatter: NoteFrontmatter = {
      type: "note",
      date: new Date().toISOString().split("T")[0],
      tags: tags ?? [],
    };

    const fileContent = matter.stringify(content, frontmatter);
    fs.writeFileSync(resolved, fileContent, "utf-8");

    return path.relative(this.root, resolved);
  }

  /**
   * Update an existing note. Supports optimistic concurrency.
   *
   * If `ifModifiedSince` is provided and the on-disk mtime exceeds it,
   * throws an Error prefixed `CONFLICT:` so the tool layer can map it to
   * a `ToolError("CONFLICT")`. This protects against last-writer-wins
   * when concurrent edits happen.
   */
  updateNote(
    notePath: string,
    updates: {
      content?: string;
      frontmatter?: Partial<NoteFrontmatter>;
      ifModifiedSince?: number;
    }
  ): string {
    const resolved = validatePath(notePath, this.root);
    validateExtension(resolved);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Note not found: ${notePath}`);
    }

    if (updates.ifModifiedSince !== undefined) {
      const onDiskMtime = Math.floor(fs.statSync(resolved).mtimeMs);
      if (onDiskMtime > updates.ifModifiedSince) {
        throw new Error(
          `CONFLICT: note ${notePath} was modified at ${onDiskMtime} (after ifModifiedSince=${updates.ifModifiedSince})`
        );
      }
    }

    const raw = fs.readFileSync(resolved, "utf-8");
    const { data, content } = matter(raw);
    const currentFm = sanitizeFrontmatter(data);

    const newFm = updates.frontmatter
      ? { ...currentFm, ...sanitizeFrontmatter(updates.frontmatter) }
      : currentFm;
    const newContent = updates.content ?? content;

    const fileContent = matter.stringify(newContent, newFm);
    fs.writeFileSync(resolved, fileContent, "utf-8");

    return path.relative(this.root, resolved);
  }

  deleteNote(notePath: string): string {
    const resolved = validatePath(notePath, this.root);
    validateExtension(resolved);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Note not found: ${notePath}`);
    }

    const archiveDir = path.join(this.root, "Archive");
    fs.mkdirSync(archiveDir, { recursive: true });

    const basename = path.basename(resolved);
    const timestamp = Date.now();
    const archivePath = path.join(archiveDir, `${timestamp}_${basename}`);

    fs.renameSync(resolved, archivePath);

    return path.relative(this.root, archivePath);
  }

  listNotes(directory?: string, recursive = true): string[] {
    const baseDir = directory
      ? validatePath(directory, this.root)
      : this.root;

    const notes: string[] = [];
    this.walkDir(baseDir, recursive, notes);
    return notes.map((n) => path.relative(this.root, n));
  }

  private walkDir(dir: string, recursive: boolean, results: string[]): void {
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

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (recursive) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              this.walkDir(fullPath, recursive, results);
            }
          } catch {
            // broken symlink or permission error
          }
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
          results.push(fullPath);
        }
      }
    }
  }

  private extractLinks(content: string): string[] {
    // Local regex instance — never share global-flag regexes across calls
    // (RegExp.exec maintains lastIndex and is not concurrency-safe).
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      links.push(match[1].trim().replace(/\\$/, ""));
    }
    return [...new Set(links)];
  }
}
