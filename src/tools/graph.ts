import { z } from "zod";
import type { GraphEngine } from "../core/graph-engine.js";
import type { ToolDefinition, ToolResult } from "../types.js";

/**
 * Output schema for brain.graph.stats. Demonstrates the 2025-06-18 spec
 * convention: tools that return structured data declare an outputSchema,
 * and the pipeline validates structuredContent against it.
 */
const GraphStatsOutputSchema = z.object({
  totalNotes: z.number(),
  totalEdges: z.number(),
  orphanNotes: z.number(),
  mostConnected: z.array(
    z.object({
      path: z.string(),
      connections: z.number(),
    })
  ),
});

/**
 * Graph tools — all read-only operations over the wikilink graph.
 *
 *   brain.graph.neighbors  → BFS traversal at depth 1-5
 *   brain.graph.backlinks  → Notes linking TO a given note
 *   brain.graph.path       → Shortest path between two notes
 *   brain.graph.stats      → Counts, orphans, most-connected
 */

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createGraphTools(graph: GraphEngine): ToolDefinition[] {
  return [
    {
      name: "brain.graph.neighbors",
      version: "1.0.0",
      description: "Find notes connected to a given note via wikilinks (BFS traversal).",
      permission: "read",
      inputSchema: {
        note: z
          .string()
          .describe("Path to the note (e.g. 'Learnings/job-hunting/index.md')"),
        depth: z
          .number()
          .min(1)
          .max(5)
          .optional()
          .default(2)
          .describe("How many hops to traverse (1-5)"),
      },
      handler: async ({ note, depth }) => {
        const neighbors = graph.getNeighbors(note, depth);
        return ok({ note, depth, count: neighbors.length, neighbors });
      },
    },

    {
      name: "brain.graph.backlinks",
      version: "1.0.0",
      description: "Find all notes that link TO a given note.",
      permission: "read",
      inputSchema: {
        note: z.string().describe("Path to the target note"),
      },
      handler: async ({ note }) => {
        const backlinks = graph.getBacklinks(note);
        return ok({ note, count: backlinks.length, backlinks });
      },
    },

    {
      name: "brain.graph.path",
      version: "1.0.0",
      description: "Find the shortest path between two notes via wikilinks.",
      permission: "read",
      inputSchema: {
        from: z.string().describe("Starting note path"),
        to: z.string().describe("Target note path"),
      },
      handler: async ({ from, to }) => {
        const pathResult = graph.findPath(from, to);
        if (!pathResult) {
          return ok({ from, to, connected: false, path: null });
        }
        return ok({
          from,
          to,
          connected: true,
          hops: pathResult.length - 1,
          path: pathResult,
        });
      },
    },

    {
      name: "brain.graph.stats",
      version: "1.0.0",
      description:
        "Get statistics about the knowledge graph (total notes, edges, orphans, most connected).",
      permission: "read",
      inputSchema: {},
      outputSchema: GraphStatsOutputSchema,
      handler: async () => {
        const stats = graph.getStats();
        return {
          content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
          structuredContent: stats as unknown as Record<string, unknown>,
        };
      },
    },
  ];
}
