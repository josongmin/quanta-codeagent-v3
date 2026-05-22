/**
 * Core tool-use rules (verbatim move from the prior `src/agent/prompt-rules.ts`).
 *
 * Why this file exists: the 6 rules below were inline string-array entries in
 * `prompt.ts`. Pulling them into a typed list with explicit `id`s gives:
 *   - A single, audit-friendly place to read/review the agent's safety contract.
 *   - Stable IDs that anti-regression tests pin (so a rename of the text
 *     content cannot silently drop a rule the model relies on).
 *   - One render path (`renderToolUseRules()`) that the prompt builder calls,
 *     preserving byte-identical output relative to the inline form.
 *
 * NOT externalized (by design): rules are part of the agent's safety / honesty
 * contract. Operator-mutable rules via env or config would let a host silently
 * disable a guardrail (e.g. drop R-ENV and let the agent thrash on pip).
 * Adding a rule means editing this file and updating the snapshot tests —
 * exactly the friction we want at this seam.
 *
 * The order matters: the model reads them top-down and R-ENV / R-STOP-ENV are
 * the most load-bearing — keep them first.
 */

export interface PromptRule {
  /** Stable ID embedded inline (`[R-…]`) — anti-regression tests pin this. */
  readonly id: string
  /** Pre-wrapped lines that render as the existing bullet block. The first
   *  line starts with `- [<id>] …`; continuations indent with 2 spaces. The
   *  shape is deliberately literal so the rendered byte output is identical
   *  to the prior inline form (cache-prefix invariance). */
  readonly lines: readonly string[]
}

/** The 6 core tool-use rules — byte-identical to the prior `TOOL_USE_RULES`
 *  list. Mode-specific packs (assistant / task-runner / benchmark / pr-agent)
 *  include these in full and may append additional rules. */
export const CORE_RULES: readonly PromptRule[] = [
  {
    id: "R-ENV",
    lines: [
      "- [R-ENV] Do NOT attempt to install dependencies or modify the environment.",
      "  Commands like `pip`, `pip3`, `python -m pip`, `npm`, `yarn`, `apt`,",
      "  `apt-get`, `conda`, `brew`, `chmod`, `chown`, `export`, `sudo` are owned",
      "  by the harness, not by you. If a verify command fails because the",
      "  environment is missing a package or a binary, declare that the environment",
      "  is unavailable for verification and stop — your patch is the deliverable,",
      "  not a working env.",
    ],
  },
  {
    id: "R-STOP-ENV",
    lines: [
      "- [R-STOP-ENV] When you have made the minimum coherent code change and",
      "  verification is blocked by env (not by failing assertions), STOP.",
      "  Repeating the same install or env command will not unblock you. Switching",
      "  tactic means changing the code, not retrying the command.",
    ],
  },
  {
    id: "R-SEARCH-FIRST",
    lines: [
      "- [R-SEARCH-FIRST] To locate files or symbols, prefer `localize` first; use",
      "  `grep`/`glob` only with a concrete pattern you have evidence for. Do not",
      "  fire repeated broad globs hoping for a match.",
    ],
  },
  {
    id: "R-READ-FAILURE",
    lines: [
      "- [R-READ-FAILURE] When a test fails, READ the failure output before making",
      "  any edit. Cite the failing assertion or error in your reasoning. Never edit",
      "  blindly in response to a red test.",
    ],
  },
  {
    id: "R-NO-THRASH",
    lines: [
      "- [R-NO-THRASH] Reissuing the same tool call, or trying spelling variants of",
      "  an edit that did not land, will not change the result. If something fails,",
      "  diagnose the actual cause and change approach — do not repeat or",
      "  vary-and-retry blindly.",
    ],
  },
  {
    id: "R-NO-SHIM",
    lines: [
      "- [R-NO-SHIM] Do NOT create stub/mock/shim files (e.g. a fake `toml.py`,",
      "  `pytest.py`, or an empty package) to bypass a missing dependency or to",
      "  force a test to pass. If verification fails because a dependency or",
      "  binary is missing, that is an environment limitation: declare the",
      "  environment unavailable and stop. Your patch fixes the bug, not the",
      "  test runner — files that exist only to silence an import error are not",
      "  part of the fix and corrupt the diff.",
    ],
  },
]
