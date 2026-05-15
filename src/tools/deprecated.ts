import type { ToolDefinition, Deprecation } from "../types.js";

/**
 * Deprecated legacy aliases for the 12 namespaced tools.
 *
 * Every old name (read_note, hybrid_search, graph_neighbors, ...) is kept
 * functional and delegates to its namespaced counterpart. The pipeline
 * adds `_meta.deprecated` to every response, so clients can warn users
 * to migrate.
 *
 * Sunset date: 2026-09-01. After that, this file is deleted and clients
 * that haven't migrated start getting `tools/list` without these entries.
 *
 * Demo answer to "Show me a deprecated tool":
 *   - Open this file → show the data-driven map below.
 *   - Show the response: same `content` as the new tool, but with
 *     `_meta.deprecated = { since, replacement, sunset }`.
 *   - Show `tools/list` output: descriptions are prefixed `[DEPRECATED ...]`.
 */

const LEGACY_MAP: Record<string, string> = {
  // crud
  read_note: "brain.notes.read",
  write_note: "brain.notes.write",
  update_note: "brain.notes.update",
  delete_note: "brain.notes.delete",
  list_notes: "brain.notes.list",
  // search
  fulltext_search: "brain.search.fulltext",
  semantic_search: "brain.search.semantic",
  hybrid_search: "brain.search.hybrid",
  // graph
  graph_neighbors: "brain.graph.neighbors",
  graph_backlinks: "brain.graph.backlinks",
  graph_path: "brain.graph.path",
  graph_stats: "brain.graph.stats",
};

const DEPRECATION_META: Deprecation = {
  since: "1.1.0",
  sunset: "2026-09-01",
};

/**
 * Build deprecated aliases that delegate to the namespaced tools.
 *
 * The alias shares the same input schema, permission, and idempotency hint
 * as the target. Its handler just forwards `args, ctx` to the target's
 * handler — no extra work, no separate code path.
 */
export function createDeprecatedAliases(
  namespacedTools: ToolDefinition[]
): ToolDefinition[] {
  const byName = new Map(namespacedTools.map((t) => [t.name, t]));
  const aliases: ToolDefinition[] = [];

  for (const [legacyName, namespacedName] of Object.entries(LEGACY_MAP)) {
    const target = byName.get(namespacedName);
    if (!target) {
      // Tolerant of partial registries (e.g. tests that wire only CRUD tools).
      // In production all 12 are always present.
      continue;
    }

    aliases.push({
      name: legacyName,
      version: "0.9.0",
      description: `Legacy alias for ${namespacedName}. ${target.description}`,
      permission: target.permission,
      idempotent: target.idempotent,
      // Shallow-clone the schema shape so mutating the alias never bleeds
      // back into the namespaced target (defensive — pipeline doesn't mutate,
      // but the invariant is brittle to defend).
      inputSchema: { ...target.inputSchema },
      deprecated: {
        ...DEPRECATION_META,
        replacement: namespacedName,
      },
      handler: target.handler,
    });
  }

  return aliases;
}
