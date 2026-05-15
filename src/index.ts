#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrainServer } from "./server.js";

/**
 * Entry point — wires the MCP server to the stdio transport and installs
 * graceful-shutdown handlers.
 *
 * Lifecycle:
 *   - Optional `--reindex` flag triggers a full reindex before starting.
 *   - With `--reindex-only` the process exits after indexing (no transport).
 *   - SIGTERM / SIGINT trigger graceful shutdown: close transport → close db.
 *   - mcpServer.server.onclose fires if the client disconnects; we close the db.
 *   - Uncaught exceptions / unhandled rejections are logged and exit non-zero.
 *
 * Logs are line-delimited JSON to stderr (stdout is reserved for the
 * MCP transport — DO NOT write to stdout).
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const shouldReindex = args.includes("--reindex");

  const { mcpServer, indexer, db, logger } = createBrainServer();

  let closed = false;
  const safeCloseDb = (): void => {
    if (closed) return;
    closed = true;
    try {
      db.close();
      logger.info("db.closed");
    } catch (err) {
      logger.error("db.close.failed", { error: String(err) });
    }
  };

  if (shouldReindex) {
    logger.info("reindex.start");
    const { indexed, removed } = await indexer.fullReindex();
    logger.info("reindex.complete", { indexed, removed });

    if (args.includes("--reindex-only")) {
      safeCloseDb();
      // Small delay so native bindings can clean up before the event loop exits.
      setTimeout(() => process.exit(0), 100);
      return;
    }
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  logger.info("transport.connected", { type: "stdio" });

  // Graceful shutdown — close transport (also closes server) then db.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutdown.start", { signal });
    try {
      await mcpServer.close();
      logger.info("shutdown.transport.closed");
    } catch (err) {
      logger.error("shutdown.transport.failed", { error: String(err) });
    }
    safeCloseDb();
    logger.info("shutdown.complete");
    setTimeout(() => process.exit(0), 100);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Defensive: if the transport closes from the client side, drop the db.
  mcpServer.server.onclose = (): void => {
    logger.info("transport.closed");
    safeCloseDb();
  };

  process.on("uncaughtException", (err: Error) => {
    logger.error("uncaughtException", {
      error: err.message,
      stack: err.stack,
    });
    safeCloseDb();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    // Treat as fatal — process state is now indeterminate. Log, close db,
    // and exit non-zero so the supervisor (Claude Code / Desktop) can
    // restart with a clean slate.
    logger.error("unhandledRejection", { reason: String(reason) });
    safeCloseDb();
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "fatal",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }) + "\n"
  );
  process.exit(1);
});
