import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDefinition } from "../types.js";
import { HookPipeline } from "./pipeline.js";

/**
 * Centralized tool registry — the single source of truth for what tools
 * the server exposes.
 *
 * Tools are pure ToolDefinition data structures registered here at boot.
 * The registry knows nothing about MCP transport details; `attachTo()`
 * wires every registered definition to an McpServer in one loop.
 *
 * Demo answer to "How do I add a new tool?":
 *   1. Append a ToolDefinition to one of `src/tools/*.ts`
 *   2. Done — boot picks it up automatically.
 *
 * Internal invariants:
 *   - Tool names are unique. Re-registration throws.
 *   - Tool names must be either legacy snake_case OR namespaced
 *     `brain.<resource>.<action>`. Enforced loosely (no regex) — the
 *     production system would validate against a manifest.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(
        `Tool already registered: ${def.name} (version ${this.tools.get(def.name)!.version})`
      );
    }
    this.tools.set(def.name, def);
  }

  registerMany(defs: ToolDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  count(): number {
    return this.tools.size;
  }

  /**
   * Wire every registered tool to an MCP server.
   *
   * Each call to server.registerTool sets:
   * - description (prefixed with [DEPRECATED] when applicable)
   * - input schema (raw Zod shape — MCP SDK wraps it)
   * - annotations: readOnlyHint, destructiveHint, idempotentHint
   * - _meta on the tool definition itself: version, permission, deprecated
   *
   * Execution flows through the HookPipeline — handlers don't talk
   * to the MCP server directly.
   */
  attachTo(server: McpServer, pipeline: HookPipeline): void {
    for (const def of this.tools.values()) {
      const desc = def.deprecated
        ? `[DEPRECATED since ${def.deprecated.since}${
            def.deprecated.replacement ? `, use ${def.deprecated.replacement}` : ""
          }] ${def.description}`
        : def.description;

      // The SDK validates args against inputSchema before calling our cb,
      // so `args` arrives already-parsed. We still pass through the pipeline
      // for permission/audit/idempotency/metrics/error-wrap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cb = (async (args: any) => pipeline.execute(def, args)) as any;

      server.registerTool(
        def.name,
        {
          description: desc,
          inputSchema: def.inputSchema,
          annotations: {
            title: def.name,
            readOnlyHint: def.permission === "read",
            destructiveHint: def.permission === "destructive",
            idempotentHint: !!def.idempotent,
            openWorldHint: false,
          },
          _meta: {
            version: def.version,
            permission: def.permission,
            deprecated: def.deprecated ?? null,
          },
        },
        cb
      );
    }
  }
}
