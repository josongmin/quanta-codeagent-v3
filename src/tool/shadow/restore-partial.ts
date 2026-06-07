/** `shadow_restore_partial` — ADR-0122 path-scoped counterpart to
 *  `shadow_rewind`. Restores ONLY the named files from the last registered
 *  shadow snapshot, leaving every other file in the worktree untouched.
 *
 *  `target:"verified"` is intentionally NOT implemented for the path-scoped
 *  v1 surface. The tool must surface that as an explicit typed
 *  `not-implemented` error instead of pretending the verified anchor is
 *  missing.
 *
 *  Output contract: same typed-error mapping as `shadow_rewind` —
 *  every `ShadowOdbError` collapses to an `ok:false` whose `output`
 *  starts with the error code (e.g. `"uninitialized: …"`,
 *  `"not-implemented: …"`, `"rewind-failed: …"`). Non-typed throws
 *  bubble (programmer-bug convention, mirrors `_shared.safeRun`).
 *
 *  Plane-clean: imports only `@/storage/shadow-odb`, `../types`, `zod`. */

import { z } from "zod"
import { type ShadowOdb, ShadowOdbError } from "@/storage/shadow-odb"
import type { Tool, ToolContext, ToolEvent } from "../types"

export const shadowRestorePartialInputSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("REPO-RELATIVE paths to restore (no absolute paths, no `..` segments)."),
  target: z
    .enum(["last", "verified"])
    .optional()
    .describe(
      "Snapshot selector. 'last' is supported; path-scoped 'verified' restore is reserved but not implemented in v1.",
    ),
  allowDirtyMerge: z
    .boolean()
    .optional()
    .describe("When true, proceed even if .git/MERGE_HEAD exists. Default false."),
})
export type ShadowRestorePartialInput = z.infer<typeof shadowRestorePartialInputSchema>

const MAX_OUTPUT = 4_000

const errorToResult = (e: unknown): string => {
  if (!(e instanceof ShadowOdbError)) throw e
  return `${e.code}: ${e.message}`
}

const unsupportedVerifiedRestore = (): ShadowOdbError =>
  new ShadowOdbError(
    "not-implemented",
    "partial restore from 'verified' is not supported in v1 — use shadow_rewind " +
      "{target:'verified'} for the full-tree path, or omit target for path-scoped restore " +
      "from the last registered snapshot.",
  )

/** Render the success output. Truncates the file list at MAX_OUTPUT chars
 *  so a 5000-path call doesn't blow the model context. */
const renderOk = (count: number, target: "last" | "verified", paths: readonly string[]): string => {
  const fileWord = count === 1 ? "file" : "files"
  const joined = paths.join(", ")
  const head = `Restored ${count} ${fileWord} from ${target}: ${joined}`
  if (head.length <= MAX_OUTPUT) return head
  return `${head.slice(0, MAX_OUTPUT)}… (truncated, ${head.length - MAX_OUTPUT} more chars)`
}

export const shadowRestorePartialTool = (odb: ShadowOdb): Tool<ShadowRestorePartialInput> => ({
  name: "shadow_restore_partial",
  description:
    "Restore ONLY the given files from the last registered shadow snapshot. Path-scoped " +
    "target='verified' requests are reserved but return not-implemented in v1. Other files in " +
    "the worktree are untouched. DESTRUCTIVE on the named files; a pre-rewind ref is auto-created " +
    "as a safety net (visible via shadow_snapshots). Paths must be repo-relative (no absolute " +
    "paths, no `..` segments).",
  inputSchema: shadowRestorePartialInputSchema,
  isReadOnly: () => false,
  // Per-workspace lock lives inside shadow-odb; concurrent partial restores
  // against the same workspace serialize there. Surface as non-concurrency-
  // safe so dispatch never batches it with sibling mutating calls.
  isConcurrencySafe: () => false,
  // Destructive on the named files — same HITL posture as shadow_rewind.
  // The blast radius is smaller (only listed paths), but the cost of a
  // mistake (silent overwrite of a file the user just edited) is the same.
  hitlTier: () => "always-confirm",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = shadowRestorePartialInputSchema.safeParse(input)
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
    // exactOptionalPropertyTypes — conditional-spread so absent input
    // keys stay ABSENT in the opts bag (not undefined-set). Mirrors the
    // shadow_rewind tool's spread posture (HELL-C8/C9 style assertion).
    const opts: { allowDirtyMerge?: boolean } = {
      ...(parsed.data.allowDirtyMerge !== undefined
        ? { allowDirtyMerge: parsed.data.allowDirtyMerge }
        : {}),
    }
    const target = parsed.data.target ?? "last"
    if (target === "verified") {
      yield {
        type: "result",
        result: { ok: false, output: errorToResult(unsupportedVerifiedRestore()) },
      }
      return
    }
    yield {
      type: "progress",
      message: `shadow_restore_partial: capturing safety-net ref + restoring ${parsed.data.paths.length} path(s) from ${target}…`,
    }
    try {
      await odb.restorePartial(ctx.cwd, parsed.data.paths, opts)
    } catch (e) {
      yield { type: "result", result: { ok: false, output: errorToResult(e) } }
      return
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: renderOk(parsed.data.paths.length, target, parsed.data.paths),
      },
    }
  },
})
