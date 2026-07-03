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

/** The 7 core tool-use rules. Mode-specific packs (assistant / task-runner /
 *  benchmark / pr-agent) include these in full and may append additional
 *  rules. */
export const CORE_RULES: readonly PromptRule[] = [
  {
    id: "R-ENV",
    lines: [
      "- [R-ENV] Do NOT install third-party dependencies or persistently modify the",
      "  environment. Commands that fetch/install packages or change global state —",
      "  `pip`/`pip3`/`python -m pip`, `npm`, `yarn`, `apt`/`apt-get`, `conda`,",
      "  `brew`, `chmod`, `chown`, `sudo`, and a persistent `export VAR=…` — are",
      "  owned by the harness, not by you. Exception: a one-shot inline `VAR=val cmd`",
      "  (env scoped to a single command, e.g. `PYTHONPATH=. pytest`) is fine — it",
      "  installs nothing and leaves no global state. If a verify command fails only",
      "  because the repo's OWN package is not importable, retry once with",
      "  `PYTHONPATH=.` (or the repo src dir) before concluding anything. If it still",
      "  fails because a THIRD-PARTY package or a binary is genuinely missing, that is",
      "  an environment limitation: declare the environment unavailable for",
      "  verification and stop — your patch is the deliverable, not a working env.",
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
      "- [R-SEARCH-FIRST] To locate files or symbols, use `search_codebase` for",
      "  broad repo queries, `localize` for fault localization, and `grep`/`glob`",
      "  only when you already have a concrete pattern or path hypothesis. Do not",
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
  {
    id: "R-FAILURE-MODE",
    lines: [
      "- [R-FAILURE-MODE] When a tool result carries a typed `failure.mode`, branch",
      "  on it instead of regex-matching the text: not_found → re-check the path or",
      "  retry with fuzzy matching; permission_denied with isReadonly → mutations",
      "  are off, do not retry the write; rejected → revise per the reason; timeout →",
      "  narrow the scope and rerun; spawn_error → the command could not launch, use",
      "  a different command; error → read modelVisibleError for the cause.",
    ],
  },
]

/** Look up a {@link CORE_RULES} entry by ID (build-time — throws if a rename ever
 *  drops a rule {@link OWNED_RULES} reuses, so the two lists cannot silently drift). */
const coreRule = (id: string): PromptRule => {
  const rule = CORE_RULES.find((r) => r.id === id)
  if (rule === undefined) throw new Error(`core rule "${id}" not found (OWNED_RULES references it)`)
  return rule
}

/**
 * `owned` environment posture (RFC jul-2 TB levers /01) — the PARALLEL
 * rule list used when a surface OWNS its container (the Terminal brain).
 *
 * Prompt-TEXT-ONLY: this selects what the model is TOLD, never any runtime enforcement
 * (`SandboxPolicy` / `os-sandbox` are untouched by construction — this is a string list).
 *
 * Relationship to {@link CORE_RULES} (`frozen`, the DEFAULT for every existing surface):
 *   - REUSES the four universal rules verbatim (same object references, so a wording
 *     change to a shared rule updates both lists at once — no drift): R-SEARCH-FIRST,
 *     R-READ-FAILURE, R-NO-THRASH, R-FAILURE-MODE.
 *   - DROPS R-ENV / R-STOP-ENV (the frozen "do not install / stop when env-blocked"
 *     guardrails that are WRONG on an owned box where a working env IS the deliverable).
 *   - REPLACES R-NO-SHIM with a diff-integrity-only shim rule ({@link R_NO_SHIM_OWNED}):
 *     keeps the ban on stub/mock files that only silence import errors, but WITHOUT the
 *     frozen "missing dep ⇒ declare env unavailable and stop" tail (on an owned box the
 *     answer to a missing dep is to install it, not to stop).
 *   - ADDS R-ENV-OWNED (install/configure/build freely; a working env is the deliverable)
 *     and R-INSTALL-THRASH (diagnose a failed install before retrying — the install-scoped
 *     analogue of the edit-scoped R-NO-THRASH).
 */
const R_ENV_OWNED: PromptRule = {
  id: "R-ENV-OWNED",
  lines: [
    "- [R-ENV-OWNED] You own this environment. Install dependencies, configure",
    "  services, and build tooling as needed (pip/apt/npm/cargo/…). A working",
    "  environment IS part of the deliverable, not an obstacle. Prefer non-interactive",
    "  flags; re-probe after installing; a clean exit code on the verifying command is",
    "  the proof.",
  ],
}

const R_INSTALL_THRASH: PromptRule = {
  id: "R-INSTALL-THRASH",
  lines: [
    "- [R-INSTALL-THRASH] If an install or build fails, read the error and diagnose",
    "  (wrong package name, missing index, missing build dep, permissions) before",
    "  retrying — do not re-run the same install command unchanged.",
  ],
}

/** Completion signal for the owned posture. Dropping R-STOP-ENV removed its second
 *  function — "you've made the minimum coherent change, STOP". On an owned box where
 *  "a working environment IS the deliverable" an agent can rabbit-hole on env polish
 *  when env is only a MEANS; this restores a task-completion stop rail. */
const R_ENV_DONE: PromptRule = {
  id: "R-ENV-DONE",
  lines: [
    "- [R-ENV-DONE] Configuring the environment is a MEANS, not the goal. Once the",
    "  verifying command exits clean and the deliverable is in place, STOP — do not",
    "  keep installing, configuring, or polishing the environment past what the task",
    "  needs.",
  ],
}

/** Diff-integrity-only variant of R-NO-SHIM: the shim/stub ban stays, but the frozen
 *  "declare the environment unavailable and stop" tail is removed (on an owned box the
 *  fix for a missing dependency is to install it, not to stop). */
const R_NO_SHIM_OWNED: PromptRule = {
  id: "R-NO-SHIM",
  lines: [
    "- [R-NO-SHIM] Do NOT create stub/mock/shim files (e.g. a fake `toml.py`,",
    "  `pytest.py`, or an empty package) to bypass a missing dependency or to",
    "  force a test to pass. Files that exist only to silence an import error are",
    "  not part of the fix and corrupt the diff — install/configure the real",
    "  dependency instead.",
  ],
}

/** The `owned` posture rule list — see {@link R_ENV_OWNED} for the full rationale.
 *  Order mirrors the frozen list's universal-rule ordering; the owned-specific rules
 *  ride at the end so the shared honesty rails read first. */
export const OWNED_RULES: readonly PromptRule[] = [
  coreRule("R-SEARCH-FIRST"),
  coreRule("R-READ-FAILURE"),
  coreRule("R-NO-THRASH"),
  coreRule("R-FAILURE-MODE"),
  R_NO_SHIM_OWNED,
  R_ENV_OWNED,
  R_INSTALL_THRASH,
  R_ENV_DONE,
]
