import { z } from "zod";
import type { BrainDB } from "../core/database.js";
import { embed } from "../core/embedder.js";
import type { SearchResult, ToolDefinition, ToolResult } from "../types.js";

/**
 * Search tools — all read-only.
 *
 *   brain.search.fulltext  → BM25 keyword search (FTS5)
 *   brain.search.semantic  → Vector KNN via sqlite-vec
 *   brain.search.hybrid    → BM25 + KNN fused with Reciprocal Rank Fusion (k=60)
 *
 * RRF formula: score = 1/(k + rank_bm25) + 1/(k + rank_vec)
 * k=60 is the standard from the IR literature (Cormack et al. 2009).
 */

const RRF_K = 60;

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function createSearchTools(db: BrainDB): ToolDefinition[] {
  return [
    {
      name: "brain.search.fulltext",
      version: "1.0.0",
      description: "Search notes using BM25 full-text search (keyword matching).",
      permission: "read",
      inputSchema: {
        query: z.string().describe("Search query (keywords)"),
        limit: z.number().optional().default(10).describe("Max results"),
      },
      handler: async ({ query, limit }) => {
        const ftsQuery = query
          .split(/\s+/)
          .filter(Boolean)
          .map((w: string) => `"${w.replace(/"/g, "")}"`)
          .join(" OR ");

        const results = db.searchFTS(ftsQuery, limit);
        const formatted: SearchResult[] = results.map((r, i) => ({
          path: r.path,
          title: r.title,
          score: 1 / (RRF_K + i + 1),
          snippet: db.getSnippet(r.id),
        }));

        return ok({ query, resultCount: formatted.length, results: formatted });
      },
    },

    {
      name: "brain.search.semantic",
      version: "1.0.0",
      description: "Search notes using vector similarity (semantic meaning).",
      permission: "read",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        limit: z.number().optional().default(10).describe("Max results"),
      },
      handler: async ({ query, limit }) => {
        const queryEmbedding = await embed(query);
        const vecResults = db.searchVector(queryEmbedding, limit);

        const formatted: SearchResult[] = vecResults.map((r) => ({
          path: db.getNotePath(r.note_id) ?? "unknown",
          title: db.getNoteTitle(r.note_id) ?? "unknown",
          score: 1 - r.distance,
          snippet: db.getSnippet(r.note_id),
        }));

        return ok({ query, resultCount: formatted.length, results: formatted });
      },
    },

    {
      name: "brain.search.hybrid",
      version: "1.0.0",
      description:
        "Combined semantic + keyword search with Reciprocal Rank Fusion (best results).",
      permission: "read",
      inputSchema: {
        query: z.string().describe("Search query (natural language or keywords)"),
        limit: z.number().optional().default(10).describe("Max results"),
      },
      handler: async ({ query, limit }) => {
        const ftsQuery = query
          .split(/\s+/)
          .filter(Boolean)
          .map((w: string) => `"${w.replace(/"/g, "")}"`)
          .join(" OR ");

        const [ftsResults, queryEmbedding] = await Promise.all([
          Promise.resolve(db.searchFTS(ftsQuery, limit * 2)),
          embed(query),
        ]);

        const vecResults = db.searchVector(queryEmbedding, limit * 2);

        const scores = new Map<
          number,
          { path: string; title: string; ftsRank: number; vecRank: number }
        >();

        ftsResults.forEach((r, i) => {
          scores.set(r.id, {
            path: r.path,
            title: r.title,
            ftsRank: i + 1,
            vecRank: Infinity,
          });
        });

        vecResults.forEach((r, i) => {
          const existing = scores.get(r.note_id);
          if (existing) {
            existing.vecRank = i + 1;
          } else {
            scores.set(r.note_id, {
              path: db.getNotePath(r.note_id) ?? "unknown",
              title: db.getNoteTitle(r.note_id) ?? "unknown",
              ftsRank: Infinity,
              vecRank: i + 1,
            });
          }
        });

        const fused: SearchResult[] = [];
        for (const [noteId, data] of scores) {
          const rrfScore =
            1 / (RRF_K + data.ftsRank) + 1 / (RRF_K + data.vecRank);
          fused.push({
            path: data.path,
            title: data.title,
            score: rrfScore,
            snippet: db.getSnippet(noteId),
          });
        }

        fused.sort((a, b) => b.score - a.score);
        const topResults = fused.slice(0, limit);

        return ok({ query, resultCount: topResults.length, results: topResults });
      },
    },
  ];
}
