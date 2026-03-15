// Authored by: cc (Claude Code) | 2026-03-13
import type { CronConfig, CronHookEntry, CronLifecycleHookPoint } from "../config/types.cron.js";
import type { LifecycleHookRunResult } from "../config/types.hooks.js";
import { isValidJobHookPath, loadHookModule, runLifecycleHooks } from "../hooks/lifecycle.js";
import type { Logger } from "./service/state.js";
import type { CronJob } from "./types.js";

const DEFAULT_PRIORITY = 10;

export type CronHookContext = {
  hookPoint: CronLifecycleHookPoint;
  workflow: string;
  job: Pick<CronJob, "id" | "name" | "agentId" | "schedule">;
  error?: string;
  status?: string;
  durationMs?: number;
  /**
   * Mutable bag shared across all hooks in a single job run.
   * Hooks can write values here for downstream hooks to read (e.g. audit IDs, timestamps).
   */
  meta: Record<string, unknown>;
  log: Logger;
  /** Base directory for resolving relative hook script paths (defaults to cwd). */
  basePath?: string;
};

// Back-compat alias: keeps existing callers working without re-exporting the shared type directly.
export type CronHookRunResult = LifecycleHookRunResult;

/** Resolved entry with a guaranteed numeric priority for sorting. */
type ResolvedEntry = CronHookEntry & { priority: number };

/**
 * Merge global (CronConfig) and per-job hook entries for a given hook point,
 * apply filters, sort by priority, and return the resolved list.
 */
export function loadHookEntries(
  hookPoint: CronLifecycleHookPoint,
  cronConfig: CronConfig | undefined,
  job: CronJob,
  workflow = "cron",
): ResolvedEntry[] {
  const skipGlobal = job.hooks?.skipGlobal?.includes(hookPoint) ?? false;

  // Global entries from openclaw.json cron.hooks section.
  const globalEntries: ResolvedEntry[] = [];
  if (!skipGlobal) {
    const raw = cronConfig?.hooks?.[hookPoint];
    if (raw) {
      for (const entry of raw) {
        if (matchesFilter(entry, job, workflow)) {
          globalEntries.push({ ...entry, priority: entry.priority ?? DEFAULT_PRIORITY });
        }
      }
    }
  }

  // Per-job shorthand entries (string paths, no priority/filter).
  // Per-job entries are validated to prevent path traversal since jobs.json
  // may be more accessible than openclaw.json.
  const jobScripts = job.hooks?.[hookPoint];
  const jobEntries: ResolvedEntry[] = [];
  if (jobScripts) {
    for (const script of jobScripts) {
      if (!isValidJobHookPath(script)) {
        continue;
      }
      jobEntries.push({ script, priority: DEFAULT_PRIORITY });
    }
  }

  const merged = [...globalEntries, ...jobEntries];
  // Stable sort: lower priority numbers run first.
  merged.sort((a, b) => a.priority - b.priority);
  return merged;
}

/**
 * Execute hook scripts sequentially for a given lifecycle point.
 * Back-compat wrapper around runLifecycleHooks — only `beforeRun` hooks may abort.
 */
export async function runCronHooks(
  hookPoint: CronLifecycleHookPoint,
  ctx: CronHookContext,
  entries: ResolvedEntry[],
): Promise<CronHookRunResult> {
  return runLifecycleHooks(hookPoint, ctx, entries, ["beforeRun"]);
}

// Re-export shared utilities so callers that imported from this module continue to work.
export { isValidJobHookPath, loadHookModule };

function matchesFilter(entry: CronHookEntry, job: CronJob, workflow: string): boolean {
  const f = entry.filter;
  if (!f) {
    return true;
  }
  if (f.workflow && f.workflow.length > 0 && !f.workflow.includes(workflow)) {
    return false;
  }
  if (f.jobId && f.jobId.length > 0 && !f.jobId.includes(job.id)) {
    return false;
  }
  // jobName filter: case-insensitive substring match against the job's name.
  if (f.jobName && f.jobName.length > 0) {
    const nameLower = job.name.toLowerCase();
    if (!f.jobName.some((pattern) => nameLower.includes(pattern.toLowerCase()))) {
      return false;
    }
  }
  // When filter.agentId is set, jobs without an agentId do not match.
  if (f.agentId && f.agentId.length > 0 && (!job.agentId || !f.agentId.includes(job.agentId))) {
    return false;
  }
  return true;
}
