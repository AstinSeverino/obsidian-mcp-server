/**
 * In-memory tool-call metrics — per-tool latency histograms.
 *
 * Stored as a ring buffer of the last N samples per tool. Sufficient for
 * a single-process local MCP. For production multi-instance you'd push to
 * Prometheus / OpenTelemetry — the API stays the same.
 *
 * Surfaced via the `brain://stats` Resource so a client can read live
 * p50 / p95 without scraping logs.
 */

export interface MetricSummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  meanMs: number;
}

const SAMPLE_CAP = 1000;

export class ToolMetrics {
  private readonly samples = new Map<string, number[]>();
  private readonly errorCounts = new Map<string, number>();
  private readonly totalCounts = new Map<string, number>();

  observe(tool: string, latencyMs: number, status: "ok" | "error"): void {
    const arr = this.samples.get(tool) ?? [];
    arr.push(latencyMs);
    if (arr.length > SAMPLE_CAP) arr.shift();
    this.samples.set(tool, arr);

    this.totalCounts.set(tool, (this.totalCounts.get(tool) ?? 0) + 1);
    if (status === "error") {
      this.errorCounts.set(tool, (this.errorCounts.get(tool) ?? 0) + 1);
    }
  }

  summary(): Record<string, MetricSummary & { errorRate: number }> {
    const out: Record<string, MetricSummary & { errorRate: number }> = {};
    for (const [tool, arr] of this.samples) {
      const sorted = [...arr].sort((a, b) => a - b);
      const total = this.totalCounts.get(tool) ?? sorted.length;
      const errs = this.errorCounts.get(tool) ?? 0;
      out[tool] = {
        count: total,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        meanMs: sorted.reduce((a, b) => a + b, 0) / Math.max(sorted.length, 1),
        errorRate: total > 0 ? errs / total : 0,
      };
    }
    return out;
  }
}

/**
 * Nearest-rank percentile. For p=0.99 with 100 samples, returns index 98
 * (ceil(100 * 0.99) - 1 = 98 ≈ the 99th-ranked sample).
 * NOTE: index is 0-based, so we clamp via Math.max(0, …) for the empty edge.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(sorted.length * p) - 1;
  const idx = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[idx];
}
