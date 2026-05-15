import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../types.js";
import { ToolError, wrapUnknown } from "./errors.js";
import { assertPermission } from "./permissions.js";
import { IdempotencyCache } from "./idempotency.js";
import { Logger, rootLogger } from "../observability/logger.js";
import { ToolMetrics } from "../observability/metrics.js";

/**
 * Express-style middleware pipeline for tool execution.
 *
 * Each hook receives the tool definition, args, context, and a `next()`
 * continuation. Hooks chain via `next()` — return value of `next()` is the
 * result of the rest of the pipeline.
 *
 * Default stack (in order):
 *
 *   validateInput   → Zod parse, throws ToolError("VALIDATION")
 *   assertPermission→ Checks Permission vs BRAIN_PERMISSION_MODE
 *   auditStart      → logger.info("tool.start", ...)
 *   idempotency     → If def.idempotent && key, short-circuit duplicate calls
 *   metrics         → Wraps execution with timer + status
 *   errorWrap       → Catches unknown errors, wraps as ToolError("INTERNAL")
 *   validateOutput  → If def.outputSchema, parses structuredContent
 *   auditEnd        → logger.info("tool.end", { latencyMs, status })
 *
 * Adding rate-limiting / authn / circuit-breakers is one line: insert a
 * Hook in the desired position in the constructor array.
 */

export type Hook = (
  def: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
  next: () => Promise<ToolResult>
) => Promise<ToolResult>;

export interface PipelineDeps {
  logger?: Logger;
  metrics?: ToolMetrics;
  idempotencyCache?: IdempotencyCache;
}

export class HookPipeline {
  private readonly hooks: Hook[];
  private readonly logger: Logger;
  private readonly metrics: ToolMetrics;
  private readonly idempotencyCache: IdempotencyCache;

  constructor(deps: PipelineDeps = {}, extraHooks: Hook[] = []) {
    this.logger = deps.logger ?? rootLogger;
    this.metrics = deps.metrics ?? new ToolMetrics();
    this.idempotencyCache = deps.idempotencyCache ?? new IdempotencyCache();

    // Order matters. Outermost first.
    //   errorWrap  — must be outermost so it catches errors from EVERY hook
    //                below it (validation, permission, audit, etc.).
    //   auditStart — log the attempt even if validation fails.
    //   validateInput — fail fast on bad shape.
    //   permission — fail fast on scope.
    //   idempotency — short-circuit duplicate calls; wraps handler + below.
    //   metrics — timer around the handler (excludes input validation).
    //   validateOutput — runs AFTER handler returns; checks structuredContent.
    //   auditEnd — last log line; captures latency + status.
    this.hooks = [
      this.errorWrapHook(),
      this.auditStartHook(),
      this.validateInputHook(),
      this.permissionHook(),
      this.idempotencyHook(),
      this.metricsHook(),
      this.validateOutputHook(),
      this.auditEndHook(),
      ...extraHooks,
    ];
  }

  getMetrics(): ToolMetrics {
    return this.metrics;
  }

  /**
   * Execute a tool through the full hook chain.
   * Returns a ToolResult ready to be returned to the MCP client.
   */
  async execute(def: ToolDefinition, args: unknown): Promise<ToolResult> {
    const requestId = randomUUID();
    const ctx: ToolContext = {
      requestId,
      logger: this.logger.child({ requestId, tool: def.name }),
      startedAt: Date.now(),
      idempotencyKey: extractIdempotencyKey(args),
    };

    let i = -1;
    const dispatch = async (): Promise<ToolResult> => {
      i++;
      if (i < this.hooks.length) {
        return this.hooks[i](def, args, ctx, dispatch);
      }
      // Terminal: invoke the actual handler
      return this.invokeHandler(def, args, ctx);
    };

    try {
      const result = await dispatch();
      return this.attachMeta(def, result);
    } catch (err) {
      const tErr = wrapUnknown(err);
      ctx.logger.error("tool.error", {
        code: tErr.code,
        error: tErr.message,
        latencyMs: Date.now() - ctx.startedAt,
        status: "error",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: tErr.message, code: tErr.code },
              null,
              2
            ),
          },
        ],
        isError: true,
        _meta: tErr.toMeta(),
      };
    }
  }

  private async invokeHandler(
    def: ToolDefinition,
    args: unknown,
    ctx: ToolContext
  ): Promise<ToolResult> {
    // Args have been validated by validateInputHook; cast is safe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return def.handler(args as any, ctx);
  }

  private attachMeta(def: ToolDefinition, result: ToolResult): ToolResult {
    const meta: Record<string, unknown> = {
      ...(result._meta ?? {}),
      version: def.version,
      permission: def.permission,
    };
    if (def.deprecated) meta.deprecated = def.deprecated;
    return { ...result, _meta: meta };
  }

  // ---------- hooks ----------

  private validateInputHook(): Hook {
    return async (def, args, _ctx, next) => {
      try {
        z.object(def.inputSchema).parse(args);
      } catch (err) {
        throw new ToolError(
          "VALIDATION",
          err instanceof z.ZodError
            ? `Input validation failed: ${err.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")}`
            : `Input validation failed: ${String(err)}`,
          err
        );
      }
      return next();
    };
  }

  private permissionHook(): Hook {
    return async (def, _args, _ctx, next) => {
      assertPermission(def.permission);
      return next();
    };
  }

  private auditStartHook(): Hook {
    return async (def, _args, ctx, next) => {
      ctx.logger.info("tool.start", {
        version: def.version,
        permission: def.permission,
        idempotent: !!def.idempotent,
        deprecated: !!def.deprecated,
      });
      return next();
    };
  }

  private idempotencyHook(): Hook {
    return async (def, _args, ctx, next) => {
      if (!def.idempotent || !ctx.idempotencyKey) return next();
      const { result, cached } = await this.idempotencyCache.wrap(
        def.name,
        ctx.idempotencyKey,
        next
      );
      if (cached) {
        ctx.logger.info("tool.idempotency.hit", {
          idempotencyKey: ctx.idempotencyKey,
        });
        return {
          ...result,
          _meta: { ...(result._meta ?? {}), idempotencyHit: true },
        };
      }
      return result;
    };
  }

  private metricsHook(): Hook {
    return async (def, _args, ctx, next) => {
      try {
        const result = await next();
        this.metrics.observe(
          def.name,
          Date.now() - ctx.startedAt,
          result.isError ? "error" : "ok"
        );
        return result;
      } catch (err) {
        this.metrics.observe(def.name, Date.now() - ctx.startedAt, "error");
        throw err;
      }
    };
  }

  private errorWrapHook(): Hook {
    return async (_def, _args, _ctx, next) => {
      try {
        return await next();
      } catch (err) {
        throw wrapUnknown(err);
      }
    };
  }

  private validateOutputHook(): Hook {
    return async (def, _args, _ctx, next) => {
      const result = await next();
      if (!def.outputSchema || result.isError) return result;
      try {
        def.outputSchema.parse(result.structuredContent);
      } catch (err) {
        throw new ToolError(
          "INTERNAL",
          `Output validation failed for ${def.name}`,
          err
        );
      }
      return result;
    };
  }

  private auditEndHook(): Hook {
    return async (def, _args, ctx, next) => {
      const result = await next();
      ctx.logger.info("tool.end", {
        version: def.version,
        latencyMs: Date.now() - ctx.startedAt,
        status: result.isError ? "error" : "ok",
      });
      return result;
    };
  }
}

/**
 * Pull the idempotencyKey out of the args object if present.
 * Tools that opt-in declare it in their inputSchema.
 */
function extractIdempotencyKey(args: unknown): string | undefined {
  if (typeof args === "object" && args !== null && "idempotencyKey" in args) {
    const k = (args as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof k === "string" && k.length > 0) return k;
  }
  return undefined;
}
