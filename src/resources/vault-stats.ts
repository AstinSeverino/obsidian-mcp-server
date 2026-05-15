import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BrainDB } from "../core/database.js";
import type { ToolMetrics } from "../observability/metrics.js";

/**
 * Resource: brain://stats
 *
 * Live, read-only snapshot of vault state and tool performance.
 * Demonstrates the *Resource* primitive of MCP — URI-addressable
 * contextual data that clients can subscribe to.
 *
 * Returns JSON with:
 *   - notes:   total notes in the index
 *   - edges:   total wikilink edges
 *   - tools:   per-tool latency summary (p50/p95/p99, count, errorRate)
 *   - generatedAt: ISO timestamp
 *
 * Demo answer to "Tools vs Resources vs Prompts":
 *   - Tools = side-effectful actions (brain.notes.write).
 *   - Resources = read-only contextual data (this one).
 *   - Prompts = reusable templates (summarize-note-tree).
 */
export function registerStatsResource(
  server: McpServer,
  db: BrainDB,
  metrics: ToolMetrics
): void {
  server.registerResource(
    "vault-stats",
    "brain://stats",
    {
      title: "Vault statistics",
      description:
        "Live counts of notes/edges plus per-tool latency (p50/p95/p99) and error rates.",
      mimeType: "application/json",
    },
    async (uri) => {
      const body = {
        notes: db.getNoteCount(),
        edges: db.getEdgeCount(),
        tools: metrics.summary(),
        generatedAt: new Date().toISOString(),
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    }
  );
}
