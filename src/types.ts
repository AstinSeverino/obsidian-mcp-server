import type { z } from "zod";
import type { Logger } from "./observability/logger.js";
import type { Permission } from "./registry/permissions.js";

export interface NoteFrontmatter {
  type?: string;
  date?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface Note {
  path: string;
  title: string;
  frontmatter: NoteFrontmatter;
  content: string;
  links: string[];
  modifiedAt: number;
}

export interface NoteRow {
  id: number;
  path: string;
  title: string;
  frontmatter: string;
  content: string;
  modified_at: number;
  indexed_at: number;
}

export interface SearchResult {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

export interface GraphNode {
  path: string;
  title: string;
  distance: number;
}

export interface GraphStats {
  totalNotes: number;
  totalEdges: number;
  orphanNotes: number;
  mostConnected: { path: string; connections: number }[];
}

export interface EdgeRow {
  source_id: number;
  target_path: string;
  target_id: number | null;
  context: string;
}

// =============================================================================
// Tool Registry types
// =============================================================================

/**
 * Metadata for tool deprecation. When set, the tool is registered with a
 * description prefix `[DEPRECATED]` and the response carries _meta.deprecated
 * so clients can warn users to migrate.
 */
export interface Deprecation {
  since: string;          // semver of release that deprecated this tool
  replacement?: string;   // namespaced name of the replacement tool
  sunset?: string;        // ISO date when this tool will be removed
}

/**
 * The MCP tool response shape used internally.
 * `structuredContent` is optional and only populated when `outputSchema` exists.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/**
 * Per-call context threaded through the hook pipeline.
 * Each tool call gets a fresh ToolContext with its own requestId and child logger.
 */
export interface ToolContext {
  requestId: string;
  logger: Logger;
  startedAt: number;
  idempotencyKey?: string;
}

/**
 * The canonical tool definition.
 *
 * Tools are pure data + a handler. The registry consumes definitions
 * and wires them to the MCP server in a single loop — adding a 13th tool
 * is a single-file change in `src/tools/*.ts`.
 *
 * - `name`: namespaced (`brain.notes.read`) or legacy (`read_note`).
 * - `version`: semver. Bump on breaking changes; clients can pin via _meta.
 * - `permission`: enforces server-boundary checks via BRAIN_PERMISSION_MODE.
 * - `deprecated`: optional. When set, description is prefixed and response
 *   carries _meta.deprecated for client warnings.
 * - `idempotent`: hint. When `true` AND ctx.idempotencyKey is provided,
 *   the pipeline short-circuits duplicate calls via IdempotencyCache.
 * - `inputSchema`: ZodRawShape (the registry wraps it in z.object()).
 * - `outputSchema`: optional Zod schema. When set, structuredContent is
 *   validated post-execution; failures emit ToolError("INTERNAL").
 */
export interface ToolDefinition<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TInput extends Record<string, z.ZodTypeAny> = any
> {
  name: string;
  version: string;
  description: string;
  permission: Permission;
  deprecated?: Deprecation;
  idempotent?: boolean;
  inputSchema: TInput;
  outputSchema?: z.ZodTypeAny;
  handler: (
    args: { [K in keyof TInput]: z.infer<TInput[K]> },
    ctx: ToolContext
  ) => Promise<ToolResult>;
}
