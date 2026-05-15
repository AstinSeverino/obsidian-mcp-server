/**
 * Structured JSON logger.
 *
 * Writes line-delimited JSON to stderr (stdout is reserved for the MCP
 * stdio transport — never log to stdout in this process).
 *
 * Each entry carries a stable `msg` event name (e.g., "tool.start") so
 * downstream collectors (Datadog, Langfuse, Splunk) can index by event.
 *
 * Child loggers inherit base context (requestId, tool, etc.) without
 * copying — keeps allocations low in the hot path.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  tool?: string;
  latencyMs?: number;
  status?: "ok" | "error";
  [key: string]: unknown;
}

export interface LogEntry extends LogContext {
  ts: string;
  level: LogLevel;
  msg: string;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function currentMinLevel(): LogLevel {
  const raw = (process.env.BRAIN_LOG_LEVEL ?? "info").toLowerCase();
  if (raw in LEVEL_RANK) return raw as LogLevel;
  return "info";
}

export class Logger {
  constructor(private readonly base: LogContext = {}) {}

  child(extra: LogContext): Logger {
    return new Logger({ ...this.base, ...extra });
  }

  private write(level: LogLevel, msg: string, extra: LogContext = {}): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[currentMinLevel()]) return;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.base,
      ...extra,
    };
    process.stderr.write(JSON.stringify(entry) + "\n");
  }

  debug(msg: string, extra: LogContext = {}): void {
    this.write("debug", msg, extra);
  }
  info(msg: string, extra: LogContext = {}): void {
    this.write("info", msg, extra);
  }
  warn(msg: string, extra: LogContext = {}): void {
    this.write("warn", msg, extra);
  }
  error(msg: string, extra: LogContext = {}): void {
    this.write("error", msg, extra);
  }
}

export const rootLogger = new Logger({ service: "astin-brain" });
