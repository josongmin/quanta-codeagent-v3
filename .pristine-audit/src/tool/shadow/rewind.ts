/** `shadow_rewind` — ADR-0119 first-class agent tool wrapping
 *  `ShadowOdb.rewindToLast` (ADR-0118). Mutating + destructive — yields the
 *  `always-confirm` HITL tier so the HITL gate ALWAYS asks the operator before
 *  the worktree is touched (cannot be skipped by acceptEdits / pre-approval).
 *
 *  Output contract: NEVER throws past the loop. Every `ShadowOdbError` is
 *  mapped to an `ok:false` ToolResult whose `output` begins with the typed
 *  error code (e.g. `"uninitialized: …"`, `"merge-in-progress: …"`,
 *  `"rewind-failed: …"`) — future surfaces (CLI / event bus) can branch on
 *  the code without parsing prose. Non-`ShadowOdbError` throws BUBBLE — those
 *  are programmer bugs (cf. `_shared.safeRun` convention).
 *
 *  Plane-clean: this file imports only `@/storage/shadow-odb`, `../types`,
 *  and `zod` — no `@/agent`, no `@/permission`. The assembly seam
 *  (`@/agent/tier1/shadow`) wires the port. */

import { z } from "zod"
import { type ShadowOdb, ShadowOdbError } from "@/storage/shadow-odb"
import type { Tool, ToolContext, ToolEvent } from "../types"

export const shadowRewindInputSchema = z.object({
  untracked: z
    .enum(["preserve", "discard"])
    .optional()
    .describe("Untracked-file policy (default 'preserve' — safer)"),
  allowDirtyMerge: z
    .boolean()
    .optional()
    .describe("When true, proceed even if .git/MERGE_HEAD exists. Default false."),
  // ADR-0122 — which snapshot to restore. `"last"` (default) = the most
  // recent `registerHead` ref. `"verified"` = the SHADOW_LAST_VERIFIED_REF
  // (advanced ONLY when caller invokes `markVerified` — typically wired
  // via the auto-verify checkpoint bridge, ADR-0123). Absent ⇒ "last"
  // (byte-identical for every existing caller).
  target: z
    .enum(["last", "verified"])
    .optional()
    .describe(
      "Snapshot to restore (default 'last'). 'verified' uses the last markVerified anchor.",
    ),
})
export type ShadowRewindInput = z.infer<typeof shadowRewindInputSchema>

/** Map a thrown `ShadowOdbError` to a deterministic `ok:false` output line. We
 *  match the typed code so future surfaces (CLI / event bus) can reason about
 *  the cause rather than parsing prose. Unknown throws bubble (programmer bug;
 *  matches `_shared.safeRun` convention). */
const errorToResult = (e: unknown): string => {
  if (!(e instanceof ShadowOdbError)) throw e
  return `${e.code}: ${e.message}`
}

export const shadowRewindTool = (odb: ShadowOdb): Tool<ShadowRewindInput> => ({
  name: "shadow_rewind",
  description:
    "Restore tracked files in the workspace to the last registered shadow snapshot. " +
    "DESTRUCTIVE: overwrites modifications to tracked files; re-creates files deleted " +
    "since the snapshot. Untracked files are preserved by default. A pre-rewind ref " +
    "is auto-created as a safety net (visible via shadow_snapshots).",
  inputSchema: shadowRewindInputSchema,
  isReadOnly: () => false,
  // Per-workspace lock lives inside shadow-odb; concurrent rewinds against the
  // same workspace serialize there. Surface the tool as non-concurrency-safe
  // so dispatch never batches it with sibling mutating calls.
  isConcurrencySafe: () => false,
  // Destructive — ALWAYS confirm. Never `pre-approval-ok` (mistakes have real
  // cost) and never `hand-off-required` (rewind is the SAFETY-NET undo, not a
  // security primitive — operator confirmation is the right gate).
  hitlTier: () => "always-confirm",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = shadowRewindInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: { ok: false, output: "aborted before start" } }
      return
    }
    // `exactOptionalPropertyTypes: true` — every optional field is conditional-
    // spread so an absent input field stays ABSENT in the opts bag (not
    // `undefined`-set). Hellgate cases C8 + C9 sealrt this with `"untracked" in
    // arg === false` assertions.
    const opts: { untracked?: "preserve" | "discard"; allowDirtyMerge?: boolean } = {
      ...(parsed.data.untracked !== undefined ? { untracked: parsed.data.untracked } : {}),
      ...(parsed.data.allowDirtyMerge !== undefined
        ? { allowDirtyMerge: parsed.data.allowDirtyMerge }
        : {}),
    }
    const target = parsed.data.target ?? "last"
    yield {
      type: "progress",
      message: `shadow_rewind: capturing safety-net ref + restoring ${target} snapshot…`,
    }
    try {
      if (target === "verified") {
        await odb.rewindToVerified(ctx.cwd, opts)
      } else {
        await odb.rewindToLast(ctx.cwd, opts)
      }
    } catch (e) {
      yield { type: "result", result: { ok: false, output: errorToResult(e) } }
      return
    }
    const policy = parsed.data.untracked ?? "preserve"
    const label = target === "verified" ? "last verified snapshot" : "last snapshot"
    yield {
      type: "result",
      result: {
        ok: true,
        output: `Restored tracked files to ${label}. Untracked policy: ${policy}. Pre-rewind ref saved.`,
      },
    }
  },
})
