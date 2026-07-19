// `apply_patch_structured` tool — ADR-0464 CLI-promoted wire.
//
// WHAT: a model-facing `Tool` that parses a V4A patch text and applies it via
// the pure `@/patch` slice's `applyPatchStructured(patch, fs)` — the ADDITIVE,
// per-file-isolated counterpart to the throwing `apply_patch`. Instead of
// aborting the whole patch on the first bad hunk, it returns a per-file
// `AppliedChange[]` (path / changeType / error / messageForModel) which this
// tool RENDERS into `toModelOutput` so the model can self-correct ONLY the
// failed file(s) without re-emitting the whole patch (Cursor `ApplyAgentDiff`
// fidelity).
//
// WHY a separate tool (not a flag on apply_patch): `apply_patch`'s contract is
// all-or-nothing-across-the-patch + throws typed errors to the dispatch seam;
// this tool's contract is partial-success + structured per-file outcome. Two
// distinct result shapes ⇒ two tools, exactly like the `shadow*` / `mcp_tasks*`
// caller-wired siblings. The CLI explicitly promotes this sibling default-ON;
// other surfaces remain opt-in, and QUANTA_ENABLE_STRUCTURED_PATCH=0 restores
// the legacy CLI menu.
//
// ADAPTER / PORT: this tool needs the SAME guarded patch port the existing
// `apply_patch` tool uses — `FsJailFileSystemPort` (the ONE `@/storage` jail +
// jailed stat capability for stale-read preflight and baseline refresh).
// Per the composition-root discipline (ARCHITECTURE.md §intro) the concrete
// port is constructed at the apps layer and injected via the factory arg
// `makeApplyPatchStructuredTool(fs)`. When no port is injected the tool mirrors
// the existing `apply_patch` tool and constructs an `FsJailFileSystemPort`
// rooted at `ctx.cwd` per call — same jail, same chokepoint.
//
// NO-THROW: `applyPatchStructured` already returns `Result<…>` and a misbehaving
// port is captured as a per-file failure inside it. The only throwing surface is
// `parsePatch` (grammar error) — caught here and rendered as an `ok:false`
// ToolResult with a model-facing retry hint. Nothing escapes `execute`.
//
// Slice posture: leaf. Imports `@/patch` (pure slice) + this tool slice's own
// `./apply-patch` (the `FsJailFileSystemPort` adapter) + `./factory`
// (`defineTool`) + `@/shared` (`errMessage`). NO `@/agent` / `@/apps` imports.

import { z } from "zod"
// Deep-specifier imports into the `@/patch` slice. The biome slice fence keys
// the `@/patch` BARREL (`from "@/patch"`) to `@/tool/apply-patch` + `@/agent`
// only; these per-module specifiers stay within the SAME slice and preserve the
// tool → patch dependency direction (identical to what `./apply-patch` does),
// so this leaf tool can reuse the pure logic without widening the barrel fence.
import { parsePatch } from "@/patch/parser"
import { applyPatchStructured } from "@/patch/structured"
import type { AppliedChange, StructuredApplyOutcome } from "@/patch/structured-types"
import { errMessage } from "@/shared"
import { writeBudgetEvent } from "./_shared/exfil-rail-guards"
import { FsJailFileSystemPort } from "./apply-patch"
import { defineTool } from "./factory"
import {
  type GuardedPatchFileSystemPort,
  guardPatchTargets,
  guardStalePatchTargets,
  refreshPatchBaselines,
} from "./patch-mutation-safety"
import type { EditToolContext, Tool, ToolEvent, ToolResult } from "./types"

const schema = z.object({
  patch: z
    .string()
    .describe(
      "V4A patch text. Must begin with '*** Begin Patch' and end with '*** End Patch'. " +
        "Unlike apply_patch, files are applied with per-file isolation: a single failing " +
        "file does not abort the others, and you receive a per-file result so you can " +
        "re-emit ONLY the failed file.",
    ),
})

type Input = z.infer<typeof schema>

/**
 * Render a {@link StructuredApplyOutcome} into the compact, model-facing string
 * the dispatch seam forwards back to the model. Deterministic (patch order, one
 * line per file) — no heuristics. A failed file carries its `messageForModel`
 * hint so the model can self-correct just that file. Pure.
 */
const renderOutcome = (outcome: StructuredApplyOutcome): string => {
  const lines = outcome.appliedChanges.map(renderChange)
  const header = outcome.allOk
    ? `apply_patch_structured: all ${outcome.appliedChanges.length} file(s) applied`
    : `apply_patch_structured: PARTIAL — ${outcome.appliedChanges.filter((c) => c.error === undefined).length}/${outcome.appliedChanges.length} file(s) applied`
  return outcome.appliedChanges.length === 0
    ? "apply_patch_structured: no-op patch (no ops)"
    : `${header}\n${lines.join("\n")}`
}

/** One file's line in the model-facing render. On failure the `messageForModel`
 *  retry hint is appended so the model can re-emit JUST this file. Pure. */
const renderChange = (c: AppliedChange): string => {
  const where = c.movedTo !== undefined ? `${c.path} -> ${c.movedTo}` : c.path
  if (c.error === undefined) return `  [ok] ${c.changeType} ${where}`
  const hint = c.messageForModel !== undefined ? ` — ${c.messageForModel}` : ""
  return `  [FAILED] ${c.changeType} ${where}: ${c.error}${hint}`
}

/**
 * Build the `apply_patch_structured` tool over an injected
 * {@link GuardedPatchFileSystemPort}. The composition root passes the SAME
 * `FsJailFileSystemPort` posture the existing `apply_patch` tool uses. When the
 * port is omitted the tool constructs an `FsJailFileSystemPort` rooted at
 * `ctx.cwd` per call (byte-identical jail to `apply_patch`).
 *
 * DO NOT register this unconditionally in `buildDefaultTools` — it is
 * caller-wired behind the `QUANTA_ENABLE_STRUCTURED_PATCH` env gate. The CLI
 * surface explicitly seeds that gate default-ON from the tool-surface SSOT;
 * other surfaces stay opt-in. An explicit `=0` keeps the tool unconstructed
 * and restores the legacy menu byte-for-byte.
 */
export const makeApplyPatchStructuredTool = (fs?: GuardedPatchFileSystemPort): Tool<Input> =>
  defineTool<Input>({
    name: "apply_patch_structured",
    description:
      "Apply a Codex V4A patch (Add/Update/Delete/Move) with PER-FILE ISOLATION. " +
      "A single failing file does not abort the others; you receive a per-file " +
      "result with a self-correction hint for each failed file. Use this when you " +
      "want partial application + targeted retry instead of all-or-nothing apply_patch.",
    inputSchema: schema,
    isReadOnly: () => false,
    // Patch application mutates the filesystem; serialize with every other
    // mutating call — concurrency-unsafe by definition (mirrors apply_patch).
    isConcurrencySafe: () => false,
    // HITL secure-by-default: a V4A patch is a multi-file workspace mutation;
    // pre-approval covers it (same posture as apply_patch / write / edit).
    hitlTier: (): "pre-approval-ok" => "pre-approval-ok",
    interruptBehavior: (): "block" => "block",

    async *execute(input: Input, ctx: EditToolContext): AsyncIterable<ToolEvent> {
      const port = fs ?? new FsJailFileSystemPort({ jailRoot: ctx.cwd })

      // parsePatch is the only throwing surface — a grammar error is recoverable
      // by the model, so render it as an ok:false retry result instead of
      // throwing past the loop.
      let parsed: ReturnType<typeof parsePatch>
      try {
        parsed = parsePatch(input.patch)
      } catch (e) {
        yield {
          type: "result",
          result: {
            ok: false,
            output:
              `apply_patch_structured: patch did not parse: ${errMessage(e)}. ` +
              "Re-emit a valid V4A patch beginning with '*** Begin Patch' and ending with '*** End Patch'.",
            failure: { mode: "rejected", reason: errMessage(e) },
          },
        }
        return
      }

      const gitDeny = guardPatchTargets(parsed, ctx.gitWriteGuard, "apply_patch_structured")
      if (gitDeny !== null) {
        yield gitDeny
        return
      }

      const staleDeny = await guardStalePatchTargets(parsed, port, ctx)
      if (staleDeny !== null) {
        yield staleDeny
        return
      }

      // A structured patch is one user-visible filesystem-mutating request,
      // even when it contains several independently-applied file operations.
      // Consume the shared turn budget exactly once AFTER parse succeeds (a
      // malformed string cannot mutate) and BEFORE `applyPatchStructured` can
      // touch its first file.  Do not move this inside the per-file operation
      // loop: that would make one multi-file patch bypass the per-call cap.
      const budgetDeny = writeBudgetEvent(ctx)
      if (budgetDeny !== null) {
        yield budgetDeny
        return
      }

      // applyPatchStructured is no-throw — returns Result<StructuredApplyOutcome>.
      // A misbehaving port is captured as a per-file failure inside it.
      const criticalSection = ctx.criticalSection?.begin()
      let result: Awaited<ReturnType<typeof applyPatchStructured>>
      try {
        result = await applyPatchStructured(parsed, port)
      } finally {
        criticalSection?.end()
      }
      if (!result.ok) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `apply_patch_structured: ${errMessage(result.error)}`,
            failure: { mode: "rejected", reason: errMessage(result.error) },
          },
        }
        return
      }

      // allOk drives the tool-level ok flag; a partial outcome is ok:false so the
      // dispatch seam treats it as a failure the model must address — but the
      // structured payload + per-file render carry the self-correction detail.
      const outcome = result.value
      await refreshPatchBaselines(
        port,
        ctx,
        outcome.appliedChanges.flatMap((change) =>
          change.error === undefined && change.changeType !== "deleted"
            ? [change.movedTo ?? change.path]
            : [],
        ),
      )
      const toolResult: ToolResult = {
        ok: outcome.allOk,
        output: renderOutcome(outcome),
        structured: outcome,
      }
      yield { type: "result", result: toolResult }
    },

    // Compact, model-facing rendering distinct from any future UI `output`.
    // Falls back to result.output (already the structured render) when no
    // structured payload is present (e.g. the parse-error / Result-err paths).
    toModelOutput: (result: ToolResult): string => {
      const s = result.structured as StructuredApplyOutcome | undefined
      if (s !== undefined && Array.isArray(s.appliedChanges)) return renderOutcome(s)
      return result.output
    },
  })
