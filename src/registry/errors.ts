/**
 * Typed error hierarchy for tool execution.
 *
 * ToolError carries a stable code that maps to MCP _meta on the response,
 * so clients can branch on `meta.code` without parsing strings.
 *
 * Stack traces are preserved across cause boundaries — the pipeline logs
 * the full chain but only surfaces `code + message` to the caller.
 */

export type ToolErrorCode =
  | "VALIDATION"        // Zod schema rejected input
  | "PERMISSION_DENIED" // BRAIN_PERMISSION_MODE blocked the call
  | "NOT_FOUND"         // Note/resource does not exist
  | "CONFLICT"          // Optimistic concurrency / duplicate
  | "INTERNAL";         // Wraps unknown errors to avoid leaking internals

export class ToolError extends Error {
  public readonly code: ToolErrorCode;
  public readonly cause?: unknown;

  constructor(code: ToolErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.cause = cause;
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }

  toMeta(): Record<string, unknown> {
    return { code: this.code };
  }
}

export function wrapUnknown(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof Error) {
    return new ToolError("INTERNAL", err.message, err);
  }
  return new ToolError("INTERNAL", String(err));
}
