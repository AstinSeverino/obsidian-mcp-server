import pkg from "graphology";
const { DirectedGraph } = pkg;
import type { BrainDB } from "./database.js";
import type { GraphNode, GraphStats } from "../types.js";

export class GraphEngine {
  private graph: InstanceType<typeof DirectedGraph>;

  constructor(private readonly db: BrainDB) {
    this.graph = new DirectedGraph({ allowSelfLoops: false });
  }

  rebuild(): void {
    this.graph.clear();

    const noteIds = this.db.getAllNoteIds();
    for (const id of noteIds) {
      const nodePath = this.db.getNotePath(id);
      if (nodePath) {
        this.graph.mergeNode(String(id), { path: nodePath });
      }
    }

    const edges = this.db.getAllEdges();
    for (const edge of edges) {
      const sourceKey = String(edge.source_id);
      const targetKey = String(edge.target_id);

      if (this.graph.hasNode(sourceKey) && this.graph.hasNode(targetKey)) {
        if (!this.graph.hasEdge(sourceKey, targetKey)) {
          this.graph.addEdge(sourceKey, targetKey);
        }
      }
    }
  }

  getNeighbors(notePath: string, depth: number = 2): GraphNode[] {
    const noteId = this.db.getNoteId(notePath.replace(/\.md$/, "") + ".md") ??
                   this.db.getNoteId(notePath);
    if (!noteId) return [];

    const startKey = String(noteId);
    if (!this.graph.hasNode(startKey)) return [];

    const visited = new Map<string, number>();
    const queue: [string, number][] = [[startKey, 0]];
    visited.set(startKey, 0);

    while (queue.length > 0) {
      const [current, dist] = queue.shift()!;
      if (dist >= depth) continue;

      const neighbors = [
        ...this.graph.outNeighbors(current),
        ...this.graph.inNeighbors(current),
      ];

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.set(neighbor, dist + 1);
          queue.push([neighbor, dist + 1]);
        }
      }
    }

    const results: GraphNode[] = [];
    for (const [nodeKey, distance] of visited) {
      if (nodeKey === startKey) continue;
      const id = parseInt(nodeKey);
      const nodePath = this.db.getNotePath(id);
      const title = this.db.getNoteTitle(id);
      if (nodePath) {
        results.push({ path: nodePath, title: title ?? nodePath, distance });
      }
    }

    return results.sort((a, b) => a.distance - b.distance);
  }

  getBacklinks(notePath: string): GraphNode[] {
    const noteId = this.db.getNoteId(notePath.replace(/\.md$/, "") + ".md") ??
                   this.db.getNoteId(notePath);
    if (!noteId) return [];

    const key = String(noteId);
    if (!this.graph.hasNode(key)) return [];

    return this.graph.inNeighbors(key).map((nk: string) => {
      const id = parseInt(nk);
      const nPath = this.db.getNotePath(id);
      const title = this.db.getNoteTitle(id);
      return { path: nPath ?? "", title: title ?? "", distance: 1 };
    });
  }

  findPath(fromPath: string, toPath: string): string[] | null {
    const fromId = this.db.getNoteId(fromPath);
    const toId = this.db.getNoteId(toPath);
    if (!fromId || !toId) return null;

    const startKey = String(fromId);
    const endKey = String(toId);

    if (!this.graph.hasNode(startKey) || !this.graph.hasNode(endKey)) {
      return null;
    }

    const visited = new Set<string>();
    const parent = new Map<string, string>();
    const queue: string[] = [startKey];
    visited.add(startKey);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === endKey) {
        const pathResult: string[] = [];
        let node: string | undefined = endKey;
        while (node !== undefined) {
          const id = parseInt(node);
          const p = this.db.getNotePath(id);
          if (p) pathResult.unshift(p);
          node = parent.get(node);
        }
        return pathResult;
      }

      for (const neighbor of this.graph.outNeighbors(current)) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          parent.set(neighbor, current);
          queue.push(neighbor);
        }
      }
    }

    return null;
  }

  getStats(): GraphStats {
    const totalNotes = this.graph.order;
    const totalEdges = this.graph.size;

    let orphanNotes = 0;
    const connections: { path: string; connections: number }[] = [];

    this.graph.forEachNode((key: string) => {
      const degree = this.graph.degree(key);
      if (degree === 0) {
        orphanNotes++;
      }
      const id = parseInt(key);
      const p = this.db.getNotePath(id);
      if (p) {
        connections.push({ path: p, connections: degree });
      }
    });

    connections.sort((a, b) => b.connections - a.connections);

    return {
      totalNotes,
      totalEdges,
      orphanNotes,
      mostConnected: connections.slice(0, 10),
    };
  }
}
