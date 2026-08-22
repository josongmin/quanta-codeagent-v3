/**
 * `@/agent/codemode-wire` — THE security boundary for code-mode (RFC
 * jun-6-code-mode §4.2 / §5.1 / §6.1).
 *
 * This `@/agent`-side factory builds the {@link CodeCellDispatchPort} the
 * `code_cell` tool hands to the `@/codemode` sandbox. It closes over the loop's
 * LIVE `config` / `permission` / `autoClassifier` and routes EVERY in-cell tool
 * call through the EXACT SAME `dispatchTool` the loop uses — so each call passes
 * the full admissibility gate / HARD_DENY / plan-mode / permission / redaction
 * pipeline EXACTLY like an ordinary tool call. A code cell IS, to the permission
 * system, N ordinary gated tool calls.
 *
 * STRUCTURAL no-bypass (RFC §6.1): there is exactly ONE function this port may
 * call — `dispatchTool` (`./dispatch.ts`). It does NOT call a tool's `execute`,
 * does NOT touch the registry, does NOT construct its own permission context.
 * `@/codemode` cannot reach `dispatchTool` at all — it only holds the port this
 * factory returns. Inversion-of-control is the boundary.
 *
 * SECURITY-CRITICAL: every call goes through `dispatchTool` with the SAME
 * `config`/`permission`/`autoClassifier` the loop holds — no copy, no
 * relaxation. The synthesized `ToolUseBlock` id is a deterministic
 * `cell_<cellId>_<seq>` (no `Date.now`/`Math.random`).
 */

import type { CodeCellDispatchPort, DispatchOutcome } from "@/codemode"
import type { ToolUseBlock } from "@/llm"
import type { AutoModeClassifier, PermissionContext } from "@/permission"
import { errMessage } from "@/shared"
import { resolveDispatchPort } from "./dispatch"
import type { AgentConfig } from "./types"

/** Inputs for {@link buildCodeCellDispatchPort}. The trio is the loop's LIVE
 *  objects — passed by reference so the cell's gating reflects the exact
 *  posture the surrounding turn runs under (no snapshot, no widening). */
export interface CodeCellWireInput {
  readonly config: AgentConfig
  readonly permission: PermissionContext
  readonly autoClassifier?: AutoModeClassifier
  /** Stable per-cell id used to mint deterministic synthesized tool-call ids
   *  (`cell_<cellId>_<seq>`). The tool supplies a per-invocation id. */
  readonly cellId: string
}

/** Extract the model-facing content string from a {@link import("./dispatch-types").DispatchResult}.
 *  Prefers the (already-redacted) `block.content` string; falls back to the
 *  stable `preview` tag when the content is the structured `contentBlocks`
 *  form (e.g. an image tool result — not expected for read/grep/write). */
const contentOf = (result: { block: { content: unknown }; preview: string }): string =>
  typeof result.block.content === "string" ? result.block.content : result.preview

/**
 * Build the {@link CodeCellDispatchPort} for ONE cell run. Each invocation of
 * the returned port synthesizes a `ToolUseBlock` and dispatches it through the
 * real `dispatchTool`, then collapses the {@link import("./dispatch-types").DispatchResult}
 * to the minimal {@link DispatchOutcome} the sandbox consumes (`ok` + redacted
 * `content`). NEVER throws (dispatchTool has a no-throw contract; the bridge
 * additionally guards).
 *
 * The per-cell monotonic `seq` makes each synthesized id unique + replay-stable
 * (`cell_<cellId>_0`, `cell_<cellId>_1`, …) — the dispatch dedup/observability
 * surfaces see distinct ids, and a re-run is deterministic.
 */
export const buildCodeCellDispatchPort = (input: CodeCellWireInput): CodeCellDispatchPort => {
  const { config, permission, autoClassifier, cellId } = input
  let seq = 0
  return async (name: string, toolInput: unknown): Promise<DispatchOutcome> => {
    const call: ToolUseBlock = {
      type: "tool_use",
      id: `cell_${cellId}_${seq++}`,
      name,
      input: toolInput,
    }
    // THE single dispatch path. Same `config`/`permission`/`autoClassifier` the
    // loop holds — admissibility gate / HARD_DENY / plan-mode / redaction all
    // fire here, unchanged. `dispatchTool` is no-throw by contract; the catch
    // is belt-and-braces so a pathological pre-execute throw becomes an
    // ok:false outcome the cell can branch on (never an uncaught host fault).
    try {
      // H1 (DIP): the SAME injectable dispatch seam the loop uses (resolveDispatchPort ⇒ the wired
      // port or the default dispatchTool) — code-mode cells route through the identical chokepoint.
      const result = await resolveDispatchPort(config)(
        call,
        config,
        permission,
        undefined,
        autoClassifier,
      )
      return { ok: result.ok, content: contentOf(result) }
    } catch (e) {
      return { ok: false, content: `code_cell dispatch failed for ${name}: ${errMessage(e)}` }
    }
  }
}
