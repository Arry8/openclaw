// Authored by: cc (Claude Code) | 2026-03-15
import path from "node:path";
import type { LifecycleHookEntry, LifecycleHookRunResult } from "../config/types.hooks.js";
import { resolveUserPath } from "../utils.js";
import { importFileModule, resolveFunctionModuleExport } from "./module-loader.js";

const HOOK_TIMEOUT_MS = 10_000;

/** Minimal logger interface required by runLifecycleHooks. Structurally compatible with pino/cron Logger. */
export type LifecycleLogger = {
  debug: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

/**
 * Execute hook scripts sequentially for a given lifecycle point.
 * Hook failures are logged but never crash the caller.
 * Hooks at hook points listed in `abortHookPoints` may abort the job via `{ abort: true, reason }`.
 *
 * @param hookPoint - The lifecycle event name (e.g. "beforeRun", "afterComplete").
 * @param ctx - Must include `log` (LifecycleLogger) and optionally `basePath` for script resolution.
 * @param entries - Sorted, resolved hook entries to execute.
 * @param abortHookPoints - Hook points where an abort return value is honored (default: ["beforeRun"]).
 */
export async function runLifecycleHooks(
  hookPoint: string,
  ctx: { log: LifecycleLogger; basePath?: string },
  entries: (LifecycleHookEntry & { priority: number })[],
  abortHookPoints: string[] = ["beforeRun"],
): Promise<LifecycleHookRunResult> {
  if (entries.length === 0) {
    return { aborted: false };
  }

  for (const entry of entries) {
    try {
      const hookFn = await loadHookModule(entry.script, ctx.basePath);
      if (typeof hookFn !== "function") {
        ctx.log.warn(
          { hookPoint, script: entry.script },
          "lifecycle hook: module does not export a function, skipping",
        );
        continue;
      }

      const timeoutMs = entry.timeoutMs ?? HOOK_TIMEOUT_MS;
      const timeout = createTimeout(timeoutMs);
      let result: unknown;
      try {
        result = await Promise.race([hookFn(ctx), timeout.promise]);
      } finally {
        timeout.clear();
      }

      // Only designated hook points can abort execution.
      if (abortHookPoints.includes(hookPoint) && isAbortResult(result)) {
        const reason =
          "reason" in result && typeof result.reason === "string"
            ? result.reason
            : "aborted by hook";
        ctx.log.info(
          { hookPoint, script: entry.script, reason },
          "lifecycle hook: job aborted by hook",
        );
        return { aborted: true, reason };
      }
    } catch (err) {
      const isModuleError =
        err instanceof Error &&
        (err.message.includes("Cannot find module") || err.message.includes("MODULE_NOT_FOUND"));
      const logFn = isModuleError ? ctx.log.warn : ctx.log.error;
      logFn.call(
        ctx.log,
        { hookPoint, script: entry.script, err: String(err) },
        "lifecycle hook: script failed, continuing",
      );
    }
  }

  return { aborted: false };
}

function isAbortResult(value: unknown): value is { abort: boolean; reason?: string } {
  return (
    value != null &&
    typeof value === "object" &&
    "abort" in value &&
    Boolean((value as { abort: unknown }).abort)
  );
}

export async function loadHookModule(scriptPath: string, basePath?: string): Promise<unknown> {
  // Check isAbsolute before the URL-scheme regex: Windows drive-letter paths like
  // "C:\hooks\audit.cjs" match /^[a-z][a-z0-9+.-]*:/ and must not be treated as URLs.
  if (!path.isAbsolute(scriptPath) && /^[a-z][a-z0-9+.-]*:/i.test(scriptPath)) {
    // URL-scheme specifiers (file://, data:, etc.) are passed through directly.
    const mod = (await import(scriptPath)) as Record<string, unknown>;
    return mod.default ?? mod;
  }
  // Resolve relative paths against basePath (OC home) rather than process.cwd().
  // resolveUserPath handles ~ expansion; path.resolve handles the basePath anchor.
  const anchored =
    basePath && !path.isAbsolute(scriptPath) && !scriptPath.startsWith("~")
      ? path.join(basePath, scriptPath)
      : scriptPath;
  const resolved = resolveUserPath(anchored, process.env);
  const mod = await importFileModule({ modulePath: resolved, cacheBust: true });
  return resolveFunctionModuleExport({ mod, fallbackExportNames: ["default"] });
}

/**
 * Validate that a per-job hook script path does not escape the base directory
 * via path traversal (e.g. "../../secrets.env"). Global hooks from openclaw.json
 * are admin-controlled and not subject to this restriction.
 */
export function isValidJobHookPath(scriptPath: string): boolean {
  // Reject empty, absolute, URL-scheme, and traversal-based paths in per-job entries.
  if (!scriptPath.trim()) {
    return false;
  }
  // Reject URI-scheme specifiers (data:, http:, file:, etc.) — loadHookModule can import
  // them directly, which would bypass the local-file restriction for per-job hooks.
  if (/^[a-z][a-z0-9+.-]*:/i.test(scriptPath)) {
    return false;
  }
  if (path.isAbsolute(scriptPath)) {
    return false;
  }
  const normalized = path.normalize(scriptPath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    return false;
  }
  return true;
}

export function createTimeout(ms: number): { promise: Promise<never>; clear: () => void } {
  let id: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`lifecycle hook timed out after ${ms}ms`)), ms);
  });
  return { promise, clear: () => clearTimeout(id) };
}
