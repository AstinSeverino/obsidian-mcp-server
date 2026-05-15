import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Prompt: summarize-note-tree
 *
 * A reusable template that instructs the LLM to traverse a folder of
 * notes via `brain.graph.neighbors` + `brain.notes.read`, then produce
 * a structured summary (themes + gaps).
 *
 * Demonstrates the *Prompt* primitive of MCP — slash-command-style
 * templates that the user can trigger and that orchestrate tool calls
 * deterministically.
 */
export function registerSummarizeTreePrompt(server: McpServer): void {
  server.registerPrompt(
    "summarize-note-tree",
    {
      title: "Summarize a folder of notes",
      description:
        "Templated prompt that traverses a note subtree via wikilinks and produces a themes+gaps summary.",
      argsSchema: {
        rootPath: z
          .string()
          .describe("Vault-relative path of the root note (e.g. 'Projects/saas/index.md')"),
        depth: z
          .string()
          .optional()
          .describe("BFS depth (1-5). Default: 2"),
      },
    },
    ({ rootPath, depth }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Summarize the note tree rooted at "${rootPath}" (BFS depth ${depth ?? "2"}).\n\n` +
              `Procedure:\n` +
              `1. Call brain.graph.neighbors with note="${rootPath}", depth=${depth ?? "2"} to enumerate the subtree.\n` +
              `2. For each neighbor, call brain.notes.read to fetch its content + frontmatter.\n` +
              `3. Aggregate the content and produce:\n` +
              `   - 3-5 bullets covering the dominant themes\n` +
              `   - 1 paragraph identifying gaps or open questions\n` +
              `   - A list of tags that recur 2+ times\n\n` +
              `Output JSON: { themes: string[], gaps: string, recurringTags: string[] }`,
          },
        },
      ],
    })
  );
}
