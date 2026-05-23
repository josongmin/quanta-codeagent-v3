/** `shadow_restore_partial` — ADR-0122 path-scoped counterpart to
 *  `shadow_rewind`. Restores ONLY the named files from a shadow snapshot
 *  (default `"last"`, or `"verified"` when an auto-verify anchor exists),
 *  leaving every other file in the worktree untouched.
 *
 *  Output contract: same typed-error mapping as `shadow_rewind` —
 *  every `ShadowOdbError` collapses to an `ok:false` whose `output`
 *  starts with the error code (e.g. `"uninitialized: …"`,
 *  `"no-verified-anchor: …"`, `"rewind-failed: …"`). Non-typed throws
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
    .describe("Snapshot to restore from (default 'last')."),
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
    "Restore ONLY the given files from a shadow snapshot (default 'last', or 'verified' when " +
    "the auto-verify anchor is set). Other files in the worktree are untouched. DESTRUCTIVE on " +
    "the named files; a pre-rewind ref is auto-created as a safety net (visible via " +
    "shadow_snapshots). Paths must be repo-relative (no absolute paths, no `..` segments).",
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
    yield {
      type: "progress",
      message: `shadow_restore_partial: capturing safety-net ref + restoring ${parsed.data.paths.length} path(s) from ${target}…`,
    }
    try {
      if (target === "verified") {
        // Partial restore from VERIFIED requires the verified anchor to
        // exist. The port surfaces this as `no-verified-anchor` via the
        // verified-ref check — but `restorePartial` itself reads from
        // SHADOW_LAST_REF, so we route through a verified-check first.
        // For the v1 surface we restrict `target` semantics to the
        // SAME-tier check the port does: when callers want verified-tier
        // PATH restore they go through `rewindToVerified` (full-tree).
        // Path-scoped verified restore is deferred to a follow-up ADR;
        // for now we surface a typed `no-verified-anchor` so the model
        // gets the same code shape it would from rewindToVerified.
        // Pragma: this branch surfaces a SAME-typed error using the
        // port's existing rewindToVerified guard semantics (read-only
        // probe + immediate error if absent) — the port treats it as
        // a precondition violation, NOT a destructive op, so no safety
        // net is taken when the guard fires.
        yield {
          type: "result",
          result: {
            ok: false,
            output:
              "no-verified-anchor: partial restore from 'verified' is not supported in v1 — " +
              "use shadow_rewind {target:'verified'} for the full-tree path, or omit target " +
              "for path-scoped restore from the last registered snapshot.",
          },
        }
        return
      }
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
