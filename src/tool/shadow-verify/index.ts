/**
 * ADR-0400 — `shadow_verify` LLM tool.
 *
 * Wraps a `ShadowVerifyPort` into an LLM-facing tool. The model can verify a
 * V4A or unified diff against a scratch overlay BEFORE applying it to the
 * real workspace — every check (lint / typecheck / test) runs inside a
 * disposable git worktree, and the diagnostics are surfaced annotated by source.
 *
 * NOT READ-ONLY, and gated like a sandboxless `bash`. It used to declare
 * `isReadOnly: () => true` and `pre-approval-ok` on the premise that "the host tree
 * is never written to". The worktree is a location, not a jail: the `test` check runs
 * `bun test` over a tree the MODEL's patch wrote, so a patch that adds a test file
 * runs arbitrary code with the session's full host access, and before quoting a
 * `test_target` of `x; <cmd>` reached `bash -lc` verbatim. Measured (sep-13 audit):
 * under both plan-mode layers `bash` was blocked while `shadow_verify` created a file
 * on the host with zero confirmations, and it escaped an enforced ownership fence.
 * The read-only self-report was what every gate trusted — plan mode's read-only
 * bypass, the permission policy's read-only allow, and the HITL tier inference.
 * Typecheck and lint are not exempt: a patch can add a tsconfig language-service
 * plugin, which the scratch LSP loads.
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
import { errMessage } from "@/shared"
import type { CoreToolContext, Tool, ToolEvent } from "../types"

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
  // A path or pattern, never an option: quoting keeps it one shell word, but `bun test`
  // still parses a word that starts with `-` — `--preload=/host/evil.ts` ran a host file
  // outside the scratch tree (round-9 audit).
  // And not a path that leaves the scratch tree: `/abs/host/evil.test.ts` and
  // `../host/evil.test.ts` both ran a host file (round-10 audit, reproduced). A target is
  // relative, with no `..` segment.
  test_target: z
    .string()
    .refine((t) => !t.startsWith("-"), "test_target is a test path or pattern, not an option")
    .refine(
      (t) => !t.startsWith("/") && !t.startsWith("~") && !t.split(/[\\/]/).includes(".."),
      "test_target is a path or pattern inside the scratch tree: relative, with no '..'",
    )
    .optional()
    .describe(
      "Targeted test path/pattern for 'test' check: relative to the tree, no '..', not starting with '-'",
    ),
})
export type ShadowVerifyInput = z.infer<typeof shadowVerifyInputSchema>

/** POSIX single-quote one shell word. */
const shellWord = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/**
 * The exact shell line the `test` check runs — the single source for the adapter that
 * executes it and for `extractShellCommand`, so HARD_DENY evaluates the line that runs.
 * The target is ONE quoted word: it names a test path or pattern, never shell syntax.
 */
export const projectShadowTestCommand = (testTarget: string | undefined): string =>
  testTarget !== undefined && testTarget.length > 0
    ? `bun test ${shellWord(testTarget)}`
    : "bun test"

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
    "diagnostic was produced. The patch is not applied to the real workspace — " +
    "apply through `apply_patch` / `edit` / `write` separately. The checks RUN the " +
    "patched code, so each call needs the same approval as a shell command.",
  inputSchema: shadowVerifyInputSchema,
  // NOT read-only: the checks execute code the patch controls (see the module doc).
  isReadOnly: () => false,
  // Each call spins up a fresh worktree + (optionally) language servers + a
  // test runner. Concurrent calls would race on git's repo-level lock and
  // spawn N times the LSP+shell load; serialize at the dispatch seam.
  isConcurrencySafe: () => false,
  // No `hitlTier` and no `capability`, on purpose. It executes model-controlled code with
  // host access. The `test` check goes through `runShell`, so an installed shell sandbox
  // wraps it and the env is scrubbed; the lint/typecheck checks start language servers
  // with the full environment and no sandbox (this said "no OS sandbox" for every check).
  // Taken whole, that is the posture of `bash` without a sandbox profile, and it is
  // exactly what the fail-closed default gives an undeclared writer:
  // `{ always-confirm, needs-sandbox }`. Declaring `capability: needs-sandbox` would
  // restate it (measured: no change). Declaring `hitlTier: "always-confirm"` would NOT: the
  // reason becomes `declared`, which bypass mode does not relax — a stricter posture than
  // sandboxless bash, and not the one intended.
  // The `test` check's shell line, for the HARD_DENY denylist. Lint/typecheck run no
  // shell line.
  extractShellCommand: (input: ShadowVerifyInput): string | null =>
    input.checks.includes("test") ? projectShadowTestCommand(input.test_target) : null,
  async *execute(input: ShadowVerifyInput, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
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
    // NO-THROW boundary (Tool contract §2): the duck-typed `ShadowVerifyPort` is
    // adapted from `@/agent`; a rejecting adapter MUST NOT reject this iterator
    // (that hangs/corrupts the dispatch loop). Map any throw to a typed
    // `ok:false` (`mode:"error"`) result instead.
    let result: ShadowVerifyResultMirror
    try {
      result = await port.verify(
        {
          patch: parsed.data.patch,
          checks: parsed.data.checks,
          ...(parsed.data.test_target !== undefined ? { testTarget: parsed.data.test_target } : {}),
        },
        ctx.signal,
      )
    } catch (e) {
      const msg = errMessage(e)
      yield {
        type: "result",
        result: {
          ok: false,
          output: `shadow_verify: backend-error: ${msg}`,
          failure: { mode: "error", modelVisibleError: msg },
        },
      }
      return
    }
    yield {
      type: "result",
      result: { ok: result.ok, output: renderShadowVerifyResult(result) },
    }
  },
})
