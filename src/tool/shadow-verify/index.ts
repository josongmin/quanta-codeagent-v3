/**
 * ADR-0400 — `shadow_verify` LLM tool.
 *
 * Wraps a `ShadowVerifyPort` into an LLM-facing tool. The model can verify a
 * V4A or unified diff against a scratch overlay BEFORE applying it to the
 * real workspace — every check (lint / typecheck / test) runs inside the
 * disposable copy, the host tree is untouched regardless of outcome, and the
 * diagnostics are surfaced annotated by source.
 *
 * HITL tier: `pre-approval-ok`. The verify call is READ-ONLY against the real
 * workspace (the scratch overlay is a disposable git worktree owned by the
 * adapter slice; the host tree is never written to). The OS sandbox profile +
 * the LLM's intent gates upstream of this tool decide whether the *resulting*
 * patch is ever applied — `shadow_verify` only inspects.
 *
 * SLICE FENCE (ADR-0400 + RFC §3.1): `@/tool` MUST NOT `import type` from
 * `@/agent`. The wave-1 producer types (`ShadowVerifyPort` / `ShadowCheck` /
 * `ShadowDiagnostic` / `ShadowVerifyResult`) are mirrored INLINE here as
 * duck-typed shapes — the producer in `@/agent/shadow-verify` is the source
 * of truth; structural equivalence is the assignment-time check (the tier-1
 * builder constructs the producer port and passes it to `shadowVerifyTool`,
 * so a drift between producer and mirror is a `tsc` error at the call site).
 * Same pattern `@/tool/delegate` already uses for `DelegationPort` (ADR-0393).
 */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"

/** Duck-typed mirror of `@/agent/shadow-verify`'s `ShadowCheck`. Closed union. */
export type ShadowCheckMirror = "lint" | "typecheck" | "test"

/** Duck-typed mirror of `@/agent/shadow-verify`'s `ShadowDiagnostic`. */
export interface ShadowDiagnosticMirror {
  readonly file: string
  readonly line: number
  readonly col?: number
  readonly severity: "error" | "warning" | "info"
  readonly message: string
  readonly source: ShadowCheckMirror
}

/** Duck-typed mirror of `@/agent/shadow-verify`'s `ShadowVerifyResult`. */
export interface ShadowVerifyResultMirror {
  readonly ok: boolean
  readonly applied: boolean
  readonly diagnostics: readonly ShadowDiagnosticMirror[]
}

/** Duck-typed mirror of `@/agent/shadow-verify`'s `ShadowVerifyPort`. The
 *  producer slice's request shape is more permissive than the tool input —
 *  the tool builds the request from validated zod input, so it is sufficient
 *  to surface only the `verify(req, signal)` method here. */
export interface ShadowVerifyPortMirror {
  verify(
    req: {
      readonly patch: string
      readonly checks: readonly ShadowCheckMirror[]
      readonly testTarget?: string
    },
    signal?: AbortSignal,
  ): Promise<ShadowVerifyResultMirror>
}

export const shadowVerifyInputSchema = z.object({
  patch: z.string().min(1).describe("V4A patch (or unified diff) to verify"),
  checks: z
    .array(z.enum(["lint", "typecheck", "test"]))
    .min(1)
    .describe("Which checks to run in the scratch overlay"),
  test_target: z.string().optional().describe("Targeted test path/pattern for 'test' check"),
})
export type ShadowVerifyInput = z.infer<typeof shadowVerifyInputSchema>

/** Render one diagnostic as a stable single-line representation. Mirrors the
 *  `diagnostics` tool's `file:line [severity] message (source)` shape so the
 *  LLM sees a consistent format across pre-apply and post-apply checks. */
export const formatShadowDiagnostic = (d: ShadowDiagnosticMirror): string => {
  const loc = d.col !== undefined ? `${d.file}:${d.line}:${d.col}` : `${d.file}:${d.line}`
  const msg = d.message.replace(/\s+/g, " ").trim()
  return `${loc} [${d.severity}] ${msg} (${d.source})`
}

/**
 * Render a `ShadowVerifyResult` as a deterministic, model-facing text block.
 * Order is:
 *   `applied: yes|no`
 *   `ok: yes|no`
 *   one line per diagnostic (in result order)
 * Empty diagnostic list ⇒ a short "no diagnostics" trailer so the model does
 * not infer a failure from a missing list.
 */
export const renderShadowVerifyResult = (r: ShadowVerifyResultMirror): string => {
  const head = [`applied: ${r.applied ? "yes" : "no"}`, `ok: ${r.ok ? "yes" : "no"}`]
  if (r.diagnostics.length === 0) return [...head, "no diagnostics"].join("\n")
  return [...head, ...r.diagnostics.map(formatShadowDiagnostic)].join("\n")
}

/**
 * Build the `shadow_verify` tool around the closed port. The composition
 * root constructs the port via `createShadowVerifyAdapters(cwd)` +
 * `createShadowVerify(deps)` (sibling tier-1 builder) and passes the result
 * here. When the port is absent the tier-1 builder returns `[]` and this tool
 * is simply not registered.
 */
export const shadowVerifyTool = (port: ShadowVerifyPortMirror): Tool<ShadowVerifyInput> => ({
  name: "shadow_verify",
  description:
    "Verify a V4A or unified-diff patch BEFORE applying it: open an isolated " +
    "scratch overlay (NEVER the real workspace), apply the patch there, run the " +
    "requested checks (lint / typecheck / test), and return diagnostics annotated " +
    "by source. `ok:true` iff the patch applied cleanly AND no error-severity " +
    "diagnostic was produced. The real workspace is untouched regardless of " +
    "outcome — apply through `apply_patch` / `edit` / `write` separately.",
  inputSchema: shadowVerifyInputSchema,
  // Read-only against the host workspace: every side effect lives inside the
  // scratch overlay the adapter slice provisions + tears down per call.
  isReadOnly: () => true,
  // Each call spins up a fresh worktree + (optionally) language servers + a
  // test runner. Concurrent calls would race on git's repo-level lock and
  // spawn N times the LSP+shell load; serialize at the dispatch seam.
  isConcurrencySafe: () => false,
  // Read-only against the real workspace ⇒ pre-approval-ok. The model can
  // call verify freely inside the accept-edits envelope without re-prompting.
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",
  async *execute(input: ShadowVerifyInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = shadowVerifyInputSchema.safeParse(input)
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
    yield {
      type: "progress",
      message: `shadow_verify: applying patch + running ${parsed.data.checks.join("/")} in scratch overlay…`,
    }
    const result = await port.verify(
      {
        patch: parsed.data.patch,
        checks: parsed.data.checks,
        ...(parsed.data.test_target !== undefined ? { testTarget: parsed.data.test_target } : {}),
      },
      ctx.signal,
    )
    yield {
      type: "result",
      result: { ok: result.ok, output: renderShadowVerifyResult(result) },
    }
  },
})
