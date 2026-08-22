/**
 * RFC-02 / ADR-0436 — `spawn_batch` tool.
 *
 * A single structured fan-out tool: `items[]` (or `items_path`) +
 * `prompt_template` + `max_concurrency` ⇒ N templated child runs through the
 * injected runner, with per-item structured results, partial-failure isolation,
 * a hard item cap, deterministic templating, and progress streaming.
 *
 * Slice fence: imports only `zod`, `@/tool` (Tool/ToolEvent/ToolContext), and
 * sibling modules. NO `@/agent`.
 */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { loadItems } from "./load-items"
import type { BatchItemResult, BatchRunResult, SubagentBatchDeps } from "./port"
import { type ChildSpawnOptions, deriveId, type RunBatchArgs, runBatch } from "./run-batch"
import type { BatchItem } from "./template"

const itemSchema = z.union([z.string(), z.record(z.string(), z.unknown())])

export const spawnBatchInputSchema = z
  .object({
    items: z
      .array(itemSchema)
      .optional()
      .describe(
        "Inline list of items. Each item is a string OR an object of {{placeholder}} values. Mutually exclusive with items_path.",
      ),
    items_path: z
      .string()
      .optional()
      .describe(
        "Path to a .csv (header row required), .jsonl, or .json (array) file of items. Mutually exclusive with items.",
      ),
    prompt_template: z
      .string()
      .min(1)
      .describe(
        "Per-item child prompt. Use {{key}} placeholders; for string items use {{item}}. Literal braces: {{{{ }}}}.",
      ),
    max_concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max workers running at once. Defaults to the host scheduler cap; capped by it. Set 1 for sequential.",
      ),
    output_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Optional JSON object whose top-level keys each item's result must contain (parsed parent-side). Violations mark that item error; others continue.",
      ),
    per_item_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max ms a single worker may run before it is marked timed-out (others continue). Clamped to the host policy band.",
      ),
    id_field: z
      .string()
      .optional()
      .describe(
        "For object items: field to use as the stable item id in results. Default = item index.",
      ),
    max_turns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Per-worker model-turn ceiling (passed to the child budget)."),
    dependencies: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        "Capability A (task DAG): map of item id → [dep item ids]. An item runs " +
          "only AFTER every dep completes; a failed dep marks the item a dead branch " +
          "(not dispatched). Item ids come from id_field (object items) or the index. " +
          "A cyclic/dangling graph is refused. Omit for flat parallel fan-out.",
      ),
    // ── batch-wide per-worker controls (parity with spawn_agent). Applied to
    //    EVERY worker; the runner already honors each on the forked child.
    isolation: z
      .enum(["none", "worktree"])
      .optional()
      .describe('"worktree" runs EACH worker in its own isolated git worktree (own write scope).'),
    task_kind: z
      .enum(["read", "edit", "review"])
      .optional()
      .describe(
        "Coarse role for every worker (read/edit/review) — derives a default tool allowlist.",
      ),
    result_shape: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "One-line spec injected into EVERY worker's seed for the shape of its final answer.",
      ),
    effort: z
      .enum(["default", "low", "medium", "high", "max"])
      .optional()
      .describe("Effort tier capping every worker's thinking budget."),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Model id every worker runs on (must be an enabled candidate; unknown id fails the spawn).",
      ),
  })
  .strict()

export type SpawnBatchInput = z.infer<typeof spawnBatchInputSchema>

/** Render a human-readable per-item summary line. */
const renderItemLine = (r: BatchItemResult): string => {
  if (r.status === "ok") {
    const head = (r.output ?? "").split("\n")[0] ?? ""
    return `  [${r.index}] ${r.id}: ok (${r.turns} turns) ${head.slice(0, 120)}`
  }
  return `  [${r.index}] ${r.id}: error — ${r.error ?? "unknown"}`
}

/** Deterministic per-worker glyph pool (index-keyed; no RNG) — gives each
 *  spawned worker a stable visual marker in the "Spawning N agents" banner. */
const WORKER_GLYPHS = ["🟦", "🟥", "🟪", "🟨", "🟩", "🟧", "⬛", "🟫"] as const

/** Strip terminal-injection vectors from a banner field. Item text is
 *  MODEL/USER-controlled and the banner is written to the operator's terminal,
 *  so a raw `\r` (line overwrite), ANSI/C0 control, or bidi-override could FORGE
 *  banner lines / corrupt scrollback. Drop every C0 control (incl CR/ESC/tab)
 *  and the Unicode bidi-override range before display. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching control chars to STRIP them
const stripBannerUnsafe = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches control + bidi chars to strip them.
  s.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "")

/** One-line task preview for a batch item (string item ⇒ its head; object item
 *  ⇒ compact key=value head). Sanitized (no control/bidi chars) + truncated so
 *  the banner stays scannable AND uninjectable. */
const itemTaskPreview = (item: BatchItem): string => {
  const text =
    typeof item === "string"
      ? item
      : Object.entries(item as Record<string, unknown>)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(" ")
  const head = stripBannerUnsafe(text.split("\n")[0] ?? "")
  return head.length > 100 ? `${head.slice(0, 100)}…` : head
}

/** Render the "Spawning N agents" dispatch banner (parity with the screenshot
 *  fan-out UI): a header + one `Created <glyph> agent-<id> … Task: <head>` line
 *  per worker. Emitted as a progress event BEFORE the pool runs so the operator
 *  sees the fan-out shape (repo + per-worker task) up front. */
const renderSpawnBanner = (
  items: readonly BatchItem[],
  cwd: string,
  idField: string | undefined,
): string => {
  const lines = [`Spawning ${items.length} agents — repo: ${cwd}`]
  items.forEach((item, i) => {
    const glyph = WORKER_GLYPHS[i % WORKER_GLYPHS.length]
    const id = deriveId(item, i, idField)
    lines.push(`  Created ${glyph} agent-${id} — Task: ${itemTaskPreview(item)}`)
  })
  return lines.join("\n")
}

/** Render the full model-facing output string. */
const renderOutput = (run: BatchRunResult): string => {
  const { summary, items } = run
  const lines = [
    `batch complete: ${summary.ok}/${summary.total} ok, ${summary.failed} failed` +
      (summary.cancelled > 0 ? `, ${summary.cancelled} cancelled` : "") +
      ` (${summary.durationMs}ms)`,
    ...items.map(renderItemLine),
  ]
  return lines.join("\n")
}

/** Error-result helper — every call site is a pre-flight failure (invalid
 *  input / items load error), so the event is always `ok:false`. Named
 *  `errResult` (not `okResult`) so the `ok:false` payload is not misleading. */
const errResult = (message: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output: message },
})

/** Build the {@link RunBatchArgs} from validated input + loaded items, OMITTING
 *  absent optional fields (exactOptionalPropertyTypes). Pure. */
const toRunArgs = (args: SpawnBatchInput, items: readonly BatchItem[]): RunBatchArgs => {
  const childOptions = toChildOptions(args)
  return {
    items,
    promptTemplate: args.prompt_template,
    ...(args.max_concurrency !== undefined ? { maxConcurrency: args.max_concurrency } : {}),
    ...(args.per_item_timeout_ms !== undefined
      ? { perItemTimeoutMs: args.per_item_timeout_ms }
      : {}),
    ...(args.id_field !== undefined ? { idField: args.id_field } : {}),
    ...(args.max_turns !== undefined ? { maxTurns: args.max_turns } : {}),
    ...(args.output_schema !== undefined ? { outputSchema: args.output_schema } : {}),
    ...(args.dependencies !== undefined ? { dependencies: args.dependencies } : {}),
    ...(childOptions !== undefined ? { childOptions } : {}),
  }
}

/** Collect the batch-wide per-worker controls into a {@link ChildSpawnOptions},
 *  or `undefined` when none are set (so an unset batch is byte-identical). */
const toChildOptions = (args: SpawnBatchInput): ChildSpawnOptions | undefined => {
  const opts: {
    isolation?: "none" | "worktree"
    taskKind?: "read" | "edit" | "review"
    resultShape?: string
    effort?: string
    model?: string
  } = {
    ...(args.isolation !== undefined ? { isolation: args.isolation } : {}),
    ...(args.task_kind !== undefined ? { taskKind: args.task_kind } : {}),
    ...(args.result_shape !== undefined ? { resultShape: args.result_shape } : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
  }
  return Object.keys(opts).length > 0 ? opts : undefined
}

/** An empty-list run result (zero spawns). */
const emptyRun: BatchRunResult = {
  items: [],
  summary: { total: 0, ok: 0, failed: 0, cancelled: 0, durationMs: 0 },
}

/**
 * Build the `spawn_batch` tool against injected deps. Mirrors the `subagent-bg`
 * builder posture: a single factory taking the closed deps bundle.
 */
export const spawnBatchTool = (deps: SubagentBatchDeps): Tool<SpawnBatchInput> => ({
  name: "spawn_batch",
  description:
    "Fan out one templated child subagent per item over a bounded worker pool. " +
    "Provide items (inline array) OR items_path (.csv/.jsonl/.json) plus a " +
    "prompt_template with {{placeholders}}. Returns per-item structured results; " +
    "one item failing does NOT stop the rest. Use for bulk 'do X for each of these N things'.",
  inputSchema: spawnBatchInputSchema,
  // Spawning children is MUTATING (each child owns its own tool set) but the
  // batch as a whole shares no mutable state with sibling tool calls — mirror
  // spawn_agent's CONCURRENCY-SAFE classification.
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  hitlTier: () => "pre-approval-ok",

  async *execute(input: SpawnBatchInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = spawnBatchInputSchema.safeParse(input)
    if (!parsed.success) {
      yield errResult(`invalid input: ${parsed.error.message}`)
      return
    }
    const args = parsed.data

    // Load items (inline XOR file). NO-THROW.
    const loaded = await loadItems(
      {
        ...(args.items !== undefined ? { items: args.items as BatchItem[] } : {}),
        ...(args.items_path !== undefined ? { items_path: args.items_path } : {}),
      },
      deps.readFile,
    )
    if (!loaded.ok) {
      yield errResult(loaded.error)
      return
    }

    // Hard item cap — spawn 0 workers if exceeded.
    if (loaded.items.length > deps.maxItems) {
      yield errResult(
        `batch size ${loaded.items.length} exceeds cap ${deps.maxItems} — refusing to spawn.`,
      )
      return
    }

    // Empty list ⇒ ok:true, total 0, zero spawns.
    if (loaded.items.length === 0) {
      yield {
        type: "result",
        result: { ok: true, output: renderOutput(emptyRun), structured: emptyRun },
      }
      return
    }

    // Fan-out banner (parity with the parallel-spawn UI): announce the N workers
    // — repo + per-worker glyph/id/task — BEFORE the pool runs so the operator
    // sees the shape up front, not just the after-the-fact summary.
    yield {
      type: "progress",
      message: renderSpawnBanner(
        loaded.items,
        ctx.cwd,
        args.id_field !== undefined ? args.id_field : undefined,
      ),
    }

    // Stream progress through a queue the async runBatch fills as items settle.
    const progressQueue: string[] = []
    const run = await runBatch(
      toRunArgs(args, loaded.items),
      {
        ...deps,
        onProgress: (done, total, failed) => {
          progressQueue.push(`batch ${done}/${total} done (${failed} failed)…`)
        },
      },
      ctx.signal,
    )

    // Drain progress messages (best-effort; emitted after settle since runBatch
    // is awaited as a unit — the queue gives the model a per-item trace).
    for (const msg of progressQueue) {
      yield { type: "progress", message: msg }
    }

    // All-failed ⇒ surface ok:false so the model clearly sees total failure.
    const allFailed = run.summary.total > 0 && run.summary.ok === 0
    yield {
      type: "result",
      result: { ok: !allFailed, output: renderOutput(run), structured: run },
    }
  },
})
