/**
 * CLUSTER D #5 — model-facing permission self-propose tool
 * (`permission_propose_pattern`).
 *
 * The RECORDING half of ADR-0061's remember-patterns seam. The safe pure core
 * (`recordProposedPattern` + `PatternGrantStore` baseline/proposed provenance
 * split) already lives in `@/permission`; THIS file is the residual LLM-callable
 * surface that lets the model propose patterns it would like remembered so a
 * future structurally-equivalent action auto-passes (via `autoPassByPatterns`).
 *
 * SECURITY — NO-WIDEN / NO-SELF-GRANT. The tool routes EXCLUSIVELY through the
 * injected port's `recordProposed` (a duck-typed mirror of `@/permission`'s
 * `recordProposedPattern`); it NEVER touches a `PatternGrantStore.recordProposed`
 * raw write. The port enforces: a proposal is RECORDED only when EVERY proposed
 * pattern is already covered by the trusted USER/POLICY baseline; ANY uncovered
 * pattern rejects the WHOLE batch (`would_widen`, all-or-nothing — a partial
 * record could launder a widen). Recorded patterns never enter the baseline (no
 * chain-widen). Dangerous proposals are gated unless the host opted in. The model
 * can therefore NEVER self-grant a NEW capability through this tool.
 *
 * Slice posture: `@/tool` may NOT import `@/permission` (RFC §3.1 fence), so this
 * file declares a DUCK-TYPED {@link PermissionPatternProposePort} — a structural
 * mirror of the `recordProposedPattern` call shape. The composition root passes a
 * real adapter (closing over a wired `PatternGrantStore`), which matches
 * structurally. NO-THROW: a throwing port yields a typed `error` result (Tool
 * contract §2); every other path yields a typed `recorded` / `rejected` result.
 *
 * DEFAULT-OFF: registered ONLY when the composition root wires the port
 * (`DefaultToolPorts.permissionPatternPropose`, gated on
 * `QUANTA_REMEMBER_PATTERNS`); absent ⇒ not in the menu ⇒ byte-identical
 * (mirrors `automation_update` / `artifact_*`).
 */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent, ToolFailure, ToolResult } from "../types"

/** Max patterns one propose call may carry — bounds the all-or-nothing batch so
 *  the model cannot submit an unbounded coverage-check workload. */
export const PROPOSE_PATTERN_MAX = 32

/** Why a propose recording was refused. STRING-IDENTICAL to `@/permission`'s
 *  `ProposeRejectReason` (no_store / empty_patterns / dangerous_blocked /
 *  would_widen) PLUS the tool-local `empty` discriminant kept for the schema-
 *  reject path. Duck-typed mirror — `@/tool` may not import `@/permission`. */
export type ProposeRejectReason =
  | "no_store"
  | "empty_patterns"
  | "dangerous_blocked"
  | "would_widen"

/** Discriminated result of the injected port — a structural mirror of
 *  `@/permission`'s `ProposePatternResult`. NEVER throws (the producer is pure);
 *  the tool maps a thrown port to a typed `error` result defensively anyway. */
export type ProposePortResult =
  | { readonly kind: "recorded"; readonly recorded: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: ProposeRejectReason }

/** Input to the injected port — a structural mirror of `@/permission`'s
 *  `ProposePatternInput`. */
export interface ProposePortInput {
  readonly proposed: readonly string[]
  readonly isMaybeDangerous?: boolean
}

/**
 * Duck-typed mirror of the `@/permission` recording seam, narrowed to the single
 * call the tool needs. The composition root passes an adapter that closes over a
 * wired `PatternGrantStore` + the operator `allowDangerous` knob and delegates to
 * `recordProposedPattern`. The tool NEVER reaches a raw store write — this port
 * is the ONLY recording path, so the no-widen invariant cannot be bypassed.
 */
export interface PermissionPatternProposePort {
  /** Record (or reject) a model proposal. Returns the typed discriminated
   *  result; MUST enforce baseline-coverage (no-widen) + dangerous gating. */
  recordProposed(input: ProposePortInput): ProposePortResult
}

const ok = (output: string): ToolResult => ({ ok: true, output })
const err = (output: string, failure: ToolFailure): ToolResult => ({
  ok: false,
  output,
  failure,
})

export const permissionProposePatternInputSchema = z.object({
  proposed: z
    .array(z.string().min(1))
    .min(1)
    .max(PROPOSE_PATTERN_MAX)
    .describe(
      "Patterns you propose to REMEMBER for future auto-pass (e.g. " +
        '["bash:git status", "read:src/**"]). A proposal is recorded ONLY when ' +
        "every pattern is already covered by the trusted user/policy baseline; " +
        "any uncovered pattern rejects the WHOLE batch (you cannot self-grant a " +
        "new capability). 1.." +
        String(PROPOSE_PATTERN_MAX) +
        " entries.",
    ),
  is_maybe_dangerous: z
    .boolean()
    .optional()
    .describe(
      "Self-flag a dangerous proposal. true ⇒ the proposal is rejected unless " +
        "the operator opted into dangerous recording.",
    ),
})
export type PermissionProposePatternInput = z.infer<typeof permissionProposePatternInputSchema>

/** Human label for each reject reason — keeps the model's self-correction signal
 *  precise (it can branch on WHY rather than parsing prose). */
const rejectMessage = (reason: ProposeRejectReason): string => {
  switch (reason) {
    case "no_store":
      return "rejected (no_store): the pattern store is not wired this session."
    case "empty_patterns":
      return "rejected (empty_patterns): no patterns were proposed."
    case "dangerous_blocked":
      return "rejected (dangerous_blocked): a dangerous proposal needs operator opt-in."
    case "would_widen":
      return (
        "rejected (would_widen): at least one proposed pattern is NOT covered by " +
        "the trusted user/policy baseline. You cannot self-grant a new capability; " +
        "the whole batch was refused (nothing recorded)."
      )
  }
}

const makeProposeTool = (
  port: PermissionPatternProposePort,
): Tool<PermissionProposePatternInput> => ({
  name: "permission_propose_pattern",
  description:
    "Propose permission patterns to REMEMBER so future structurally-equivalent " +
    "actions auto-pass without re-asking. A proposal is RECORDED only when every " +
    "pattern is already covered by the trusted user/policy baseline; any uncovered " +
    "pattern rejects the whole batch (you can refine within what was granted, but " +
    "never self-grant a new capability). Mutating (records into the session " +
    "pattern store).",
  inputSchema: permissionProposePatternInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(
    input: PermissionProposePatternInput,
    _ctx: ToolContext,
  ): AsyncIterable<ToolEvent> {
    const parsed = permissionProposePatternInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: err(`invalid input: ${parsed.error.message}`, {
          mode: "rejected",
          reason: "bad_input",
        }),
      }
      return
    }
    // Route EXCLUSIVELY through the injected port — the only recording path, so
    // the no-widen invariant (enforced inside `recordProposedPattern`) cannot be
    // bypassed by unchecked model input. NO-THROW: a throwing port → typed error.
    let result: ProposePortResult
    try {
      result = port.recordProposed({
        proposed: parsed.data.proposed,
        ...(parsed.data.is_maybe_dangerous !== undefined
          ? { isMaybeDangerous: parsed.data.is_maybe_dangerous }
          : {}),
      })
    } catch (e) {
      yield {
        type: "result",
        result: err("permission propose port failed", {
          mode: "error",
          modelVisibleError: "permission_propose_pattern failed unexpectedly.",
          clientVisibleError: e instanceof Error ? e.message : String(e),
        }),
      }
      return
    }
    if (result.kind === "rejected") {
      yield {
        type: "result",
        result: err(rejectMessage(result.reason), { mode: "rejected", reason: result.reason }),
      }
      return
    }
    const list = result.recorded.map((p) => `  ${p}`).join("\n")
    yield {
      type: "result",
      result: ok(`Recorded ${result.recorded.length} pattern(s):\n${list}`),
    }
  },
})

/** Build the permission self-propose tool over a wired port. A single-tool array
 *  (mirrors `artifactTools` / `ptyTools` group-builder shape) so the registration
 *  site spreads it uniformly. */
export const permissionProposeTools = (port: PermissionPatternProposePort): Tool[] => [
  makeProposeTool(port) as Tool,
]
