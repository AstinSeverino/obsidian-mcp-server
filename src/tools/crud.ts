import { z } from "zod";
import type { Vault } from "../core/vault.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ToolError } from "../registry/errors.js";

/**
 * CRUD tools for note management.
 *
 * Naming convention: namespaced `brain.notes.<action>`. The legacy
 * names (`read_note`, `write_note`, ...) are kept as deprecated aliases
 * in `./deprecated.ts` for backward compatibility.
 *
 * Permission scoping:
 *   read   → brain.notes.read, brain.notes.list
 *   write  → brain.notes.write, brain.notes.update
 *   destructive → brain.notes.delete (soft-delete to Archive/)
 *
 * Write/update/delete accept an optional `idempotencyKey` — when present
 * the HookPipeline deduplicates duplicate calls within 5 minutes.
 */

function ok(payload: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
  };
}

const idempotencyKeyField = {
  idempotencyKey: z
    .string()
    .optional()
    .describe(
      "Optional UUID for idempotent retries. Same key within 5min returns the cached result."
    ),
};

export function createCrudTools(vault: Vault): ToolDefinition[] {
  return [
    {
      name: "brain.notes.read",
      version: "1.0.0",
      description: "Read a note from the vault with its frontmatter and content.",
      permission: "read",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the note (e.g. 'Research/my-note.md')"),
      },
      handler: async ({ path: notePath }) => {
        const note = vault.readNote(notePath);
        return ok({
          path: note.path,
          title: note.title,
          frontmatter: note.frontmatter,
          content: note.content,
          links: note.links,
        });
      },
    },

    {
      name: "brain.notes.write",
      version: "1.0.0",
      description: "Create a new note in the vault with frontmatter.",
      permission: "write",
      idempotent: true,
      inputSchema: {
        path: z.string().describe("Relative path for the new note"),
        title: z.string().describe("Title of the note"),
        content: z.string().describe("Markdown content of the note"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags for the note"),
        ...idempotencyKeyField,
      },
      handler: async ({ path: notePath, title, content, tags }) => {
        const created = vault.writeNote(notePath, title, content, tags);
        return ok({ created, status: "ok" });
      },
    },

    {
      name: "brain.notes.update",
      version: "1.0.0",
      description:
        "Update an existing note's content or frontmatter. Supports optimistic concurrency via ifModifiedSince.",
      permission: "write",
      idempotent: true,
      inputSchema: {
        path: z.string().describe("Relative path to the note"),
        content: z.string().optional().describe("New markdown content"),
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe("Frontmatter fields to update"),
        ifModifiedSince: z
          .number()
          .optional()
          .describe(
            "Optimistic concurrency. If the note's mtime exceeds this value, CONFLICT is raised."
          ),
        ...idempotencyKeyField,
      },
      handler: async ({ path: notePath, content, frontmatter, ifModifiedSince }) => {
        try {
          const updated = vault.updateNote(notePath, {
            content,
            frontmatter,
            ifModifiedSince,
          });
          return ok({ updated, status: "ok" });
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("CONFLICT:")) {
            throw new ToolError("CONFLICT", err.message, err);
          }
          throw err;
        }
      },
    },

    {
      name: "brain.notes.delete",
      version: "1.0.0",
      description: "Soft-delete a note by moving it to Archive/.",
      permission: "destructive",
      idempotent: true,
      inputSchema: {
        path: z.string().describe("Relative path to the note to delete"),
        ...idempotencyKeyField,
      },
      handler: async ({ path: notePath }) => {
        const archived = vault.deleteNote(notePath);
        return ok({ archived, status: "ok" });
      },
    },

    {
      name: "brain.notes.list",
      version: "1.0.0",
      description: "List all notes in a directory (or entire vault).",
      permission: "read",
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe(
            "Subdirectory to list (e.g. 'Research'). Omit for entire vault."
          ),
      },
      handler: async ({ directory }) => {
        const notes = vault.listNotes(directory);
        return ok({ count: notes.length, notes });
      },
    },
  ];
}
