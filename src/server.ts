import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import os from "node:os";
import { Vault } from "./core/vault.js";
import { BrainDB } from "./core/database.js";
import { GraphEngine } from "./core/graph-engine.js";
import { Indexer } from "./core/indexer.js";
import { createCrudTools } from "./tools/crud.js";
import { createSearchTools } from "./tools/search.js";
import { createGraphTools } from "./tools/graph.js";
import { createDeprecatedAliases } from "./tools/deprecated.js";
import { ToolRegistry } from "./registry/registry.js";
import { HookPipeline } from "./registry/pipeline.js";
import { IdempotencyCache } from "./registry/idempotency.js";
import { Logger } from "./observability/logger.js";
import { ToolMetrics } from "./observability/metrics.js";
import { registerStatsResource } from "./resources/vault-stats.js";
import { registerSummarizeTreePrompt } from "./prompts/summarize-tree.js";

/**
 * Build the MCP server with the registry + pipeline pattern.
 *
 * Wiring summary:
 *   1. Construct core services (Vault, BrainDB, GraphEngine, Indexer).
 *   2. Build observability primitives (Logger, ToolMetrics, IdempotencyCache).
 *   3. Build the HookPipeline with those primitives.
 *   4. Register all tools (namespaced + legacy aliases) into the ToolRegistry.
 *   5. Call registry.attachTo(server, pipeline) — single loop, all tools wired.
 *   6. Register the brain://stats Resource + summarize-note-tree Prompt
 *      (demonstrates all 3 MCP primitives: Tools, Resources, Prompts).
 *
 * To add a tool: append a ToolDefinition to one of `src/tools/*.ts`.
 * No changes required here.
 */

export interface BrainServer {
  mcpServer: McpServer;
  indexer: Indexer;
  db: BrainDB;
  registry: ToolRegistry;
  pipeline: HookPipeline;
  logger: Logger;
}

export function createBrainServer(): BrainServer {
  const vaultPath =
    process.env.VAULT_PATH ?? path.join(os.homedir(), "SecondBrain");

  // Don't leak the absolute vault path into every log line — keep it
  // available for the explicit init log but redact from child contexts.
  const logger = new Logger({
    service: "astin-brain",
    protocolVersion: "2024-11-05",
  });
  logger.info("server.init", { vaultPath });

  const vault = new Vault(vaultPath);
  const db = new BrainDB(vaultPath);
  const graph = new GraphEngine(db);
  const indexer = new Indexer(vaultPath, db, vault, graph);

  const metrics = new ToolMetrics();
  const idempotencyCache = new IdempotencyCache();
  const pipeline = new HookPipeline({ logger, metrics, idempotencyCache });

  // Build the registry — single source of truth for which tools exist.
  const registry = new ToolRegistry();
  const namespaced = [
    ...createCrudTools(vault),
    ...createSearchTools(db),
    ...createGraphTools(graph),
  ];
  registry.registerMany(namespaced);

  // Legacy aliases (deprecated) — keep all old names functional during
  // the migration window. Each delegates to its namespaced counterpart.
  registry.registerMany(createDeprecatedAliases(namespaced));

  const mcpServer = new McpServer({
    name: "astin-brain",
    version: "1.1.0",
  });

  // Attach every registered tool to the MCP server in a single loop.
  // This is THE answer to "show me how a new tool gets registered".
  registry.attachTo(mcpServer, pipeline);

  // The other two MCP primitives:
  // - Resource: read-only contextual data (live vault stats + tool metrics)
  // - Prompt: reusable template that orchestrates tool calls
  registerStatsResource(mcpServer, db, metrics);
  registerSummarizeTreePrompt(mcpServer);

  const stale = indexer.needsReindex();
  if (stale.length > 0) {
    logger.warn("indexer.stale", {
      staleCount: stale.length,
      hint: "will index on first search; run --reindex for full sweep",
    });
  }

  graph.rebuild();

  logger.info("server.ready", {
    toolCount: registry.count(),
    version: "1.1.0",
  });

  return { mcpServer, indexer, db, registry, pipeline, logger };
}
