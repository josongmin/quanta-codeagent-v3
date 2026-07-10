/**
 * ADR-0538 Phase 1 — the migrated TOOL-USE-RULE atoms (the SSOT).
 *
 * This file replaces the three hand-maintained rule LISTS
 * (`CORE_RULES` / `OWNED_RULES` / `DEFAULT_BASE`) and the verify-strategy render
 * switch with a single declarative atom graph. Applicability that used to be
 * expressed by WHICH LIST a rule lived in is now `when.envPosture` matchers +
 * `supersedes` edges; grader-only suppression that used to be `withoutBlocks`
 * string surgery is now `when.verifyStrategy:{not:["grader-only"]}`.
 *
 * The rendered `lines` are BYTE-IDENTICAL to the prior `core.ts` /
 * `verify-strategy.ts` text so `buildSystemPrompt` output is unchanged for every
 * posture/verify combination (the existing prompt hellgates stay green). ADR/RFC
 * citations that were in the source doc-comments live in `provenance` only —
 * they are metadata and never render.
 *
 * Slice boundary: pure text data + declarative conditions. No `@/llm`, `@/tool`.
 */

import type { InstructionAtom } from "./types"

// ─────────────────────────────────────────────────────────────────────────
// Section labels — intra-channel ordering groups (all in `system.base`).
// `posture` = the env-guardrails + honesty rails block; `verify` = the
// third-axis verify-strategy block that renders AFTER the task rules.
// ─────────────────────────────────────────────────────────────────────────
const POSTURE = "tooluse.posture"
const VERIFY = "tooluse.verify"

// Order counters preserve the exact prior render order:
//   frozen: R-ENV, R-STOP-ENV, R-SEARCH-FIRST, R-READ-FAILURE, R-NO-THRASH, R-NO-SHIM, R-FAILURE-MODE
//   owned:  R-SEARCH-FIRST, R-READ-FAILURE, R-NO-THRASH, R-FAILURE-MODE, R-NO-SHIM(owned), R-ENV-OWNED, R-INSTALL-THRASH, R-ENV-DONE
//   default:R-SEARCH-FIRST, R-READ-FAILURE, R-NO-THRASH, R-FAILURE-MODE, R-NO-SHIM(owned), R-ENV-LOCAL
// The order NUMBER encodes the frozen positions; posture-specific atoms slot by
// their own order value (see per-atom notes). Render selection is by matcher.

/**
 * The env-guardrail atom. THREE variants of ONE semantic concern ("what may the
 * agent do to the environment"):
 *   - `R-ENV` (frozen): do NOT install; env limitation ⇒ declare unavailable + stop.
 *   - `R-ENV-OWNED` (owned): you own the box — install/configure freely.
 *   - `R-ENV-LOCAL` (default): user's own machine — install permitted, not graded.
 * The three are mutually-exclusive CONTRADICTORY postures selected by DISJOINT
 * `when.envPosture` matchers (frozen vs owned vs default) — exactly one renders.
 * `conflictsWith` edges DECLARE that exclusivity so the conflict-freedom verifier
 * proves it across every reachable ctx (disjoint matchers make co-render
 * impossible; the edge is what makes the verifier witness it). This replaces the
 * three separate hand-maintained rule lists — NOT a `supersedes` edge: supersede
 * (let both apply, winner suppresses loser) would rely on selectAtoms suppression
 * and leave frozen APPLICABLE under owned; disjoint matchers + a conflict edge are
 * stronger (co-render is structurally impossible AND build-time verified).
 */
const R_ENV_FROZEN: InstructionAtom = {
  atomId: "R-ENV",
  variantId: "R-ENV#frozen",
  authority: "L1_system",
  channel: "system.base",
  section: POSTURE,
  order: 10,
  when: { envPosture: ["frozen"] },
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
  provenance: ["RFC jul-2-terminal-bench-levers/01", "ADR-0326 cached system prefix"],
}

const R_STOP_ENV_FROZEN: InstructionAtom = {
  atomId: "R-STOP-ENV",
  variantId: "R-STOP-ENV#frozen",
  authority: "L1_system",
  channel: "system.base",
  section: POSTURE,
  order: 20,
  when: { envPosture: ["frozen"] },
  lines: [
    "- [R-STOP-ENV] When you have made the minimum coherent code change and",
    "  verification is blocked by env (not by failing assertions), STOP.",
    "  Repeating the same install or env command will not unblock you. Switching",
    "  tactic means changing the code, not retrying the command.",
  ],
  provenance: ["RFC jul-2-terminal-bench-levers/01"],
}

// ── The four universal honesty/search rails — apply in EVERY posture (no
//    `when`). Order 30..60 so they follow the frozen env pair and lead the
//    posture-specific tail in owned/default. ──
const R_SEARCH_FIRST: InstructionAtom = {
  atomId: "R-SEARCH-FIRST",
  variantId: "R-SEARCH-FIRST",
  authority: "L1_system",
  channel: "system.base",
  section: POSTURE,
  order: 30,
  lines: [
    "- [R-SEARCH-FIRST] To locate files or symbols, use `search_codebase` for",
    "  broad repo queries, `localize` for fault localization, and `grep`/`glob`",
    "  only when you already have a concrete pattern or path hypothesis. Do not",
    "  fire repeated broad globs hoping for a match.",
  ],
}

const R_READ_FAILURE: InstructionAtom = {
  atomId: "R-READ-FAILURE",
  variantId: "R-READ-FAILURE",
  authority: "L1_system",
  channel: "system.base",
  section: POSTURE,
  order: 40,
  lines: [
    "- [R-READ-FAILURE] When a test fails, READ the failure output before making",
    "  any edit. Cite the failing assertion or error in your reasoning. Never edit",
    "  blindly in response to a red test.",
  ],
}

const R_NO_THRASH: InstructionAtom = {
  atomId: "R-NO-THRASH",
  variantId: "R-NO-THRASH",
  authority: "L1_system",
  channel: "system.base",
  section: POSTURE,
  order: 50,
  lines: [
    "- [R-NO-THRASH] Reissuing the same tool call, or trying spelling variants of",
    "  an edit that did not land, will not change the result. If something fails,",
    "  diagnose the actual cause and change approach — do not repeat or",
    "  vary-and-retry blindly.",
  ],
}

const R_FAILURE_MODE: InstructionAtom = {
  atomId: "R-FAILURE-MODE",
  variantId: "R-FAILURE-MODE",
  authority: "L1_system",
  channel: "system.base",
  section: POSTURE,
  // Order 70 so it renders AFTER R-NO-SHIM in frozen (frozen roster ends
  // …R-NO-SHIM, R-FAILURE-MODE) but the owned/default roster puts the honesty
  // rails first then the shim + env tail — see render note below.
  order: 70,
  lines: [
    "- [R-FAILURE-MODE] When a tool result carries a typed `failure.mode`, branch",
    "  on it instead of regex-matching the text: not_found → re-check the path or",
    "  retry with fuzzy matching; permission_denied with isReadonly → mutations",
    "  are off, do not retry the write; rejected → revise per the reason; timeout →",
    "  narrow the scope and rerun; spawn_error → the command could not launch, use",
    "  a different command; error → read modelVisibleError for the cause.",
  ],
}

// ── R-NO-SHIM: TWO variants (frozen stop-tail vs owned install-the-dep tail).
//    Same atomId, CONTRADICTORY, selected by disjoint `when.envPosture` (frozen
//    vs owned/default) with a `conflictsWith` edge declaring the exclusivity. The
//    frozen roster orders …R-NO-SHIM, R-FAILURE-MODE (shim order 60 < 70); the
//    owned/default roster orders …R-FAILURE-MODE, R-NO-SHIM (shim order 75 > 70).
//    Only one shim variant fires per posture, so the two distinct order values
//    reproduce BOTH prior rosters exactly. ──
const R_NO_SHIM_FROZEN: InstructionAtom = {
  atomId: "R-NO-SHIM",
  variantId: "R-NO-SHIM#frozen",
  authority: "L1_system",
  channel: "system.base",
  section: POSTURE,
  order: 60,
  when: { envPosture: ["frozen"] },
  lines: [
    "- [R-NO-SHIM] Do NOT create stub/mock/shim files (e.g. a fake `toml.py`,",
    "  `pytest.py`, or an empty package) to bypass a missing dependency or to",
    "  force a test to pass. If verification fails because a dependency or",
    "  binary is missing, that is an environment limitation: declare the",
    "  environment unavailable and stop. Your patch fixes the bug, not the",
    "  test runner — files that exist only to silence an import error are not",
    "  part of the fix and corrupt the diff.",
  ],
}

const R_NO_SHIM_OWNED: InstructionAtom = {
  atomId: "R-NO-SHIM",
  variantId: "R-NO-SHIM#owned",
  authority: "L3_app_env",
  channel: "system.base",
  section: POSTURE,
  // 75: AFTER R-FAILURE-MODE (70) — owned/default roster is
  // [...rails, R-FAILURE-MODE, R-NO-SHIM(owned), env-tail], the mirror of the
  // frozen roster where the shim (60) precedes R-FAILURE-MODE (70).
  order: 75,
  when: { envPosture: ["owned", "default"] },
  // The frozen shim rule ("declare env unavailable + stop") and this owned one
  // ("install the real dep") are CONTRADICTORY — they must never co-render. The
  // `when.envPosture` sets are disjoint (frozen vs owned/default), so they never
  // do; this edge DECLARES that exclusivity so the conflict-freedom verifier
  // PROVES it across every reachable ctx (a future matcher-widening would fire).
  conflictsWith: ["R-NO-SHIM#frozen"],
  lines: [
    "- [R-NO-SHIM] Do NOT create stub/mock/shim files (e.g. a fake `toml.py`,",
    "  `pytest.py`, or an empty package) to bypass a missing dependency or to",
    "  force a test to pass. Files that exist only to silence an import error are",
    "  not part of the fix and corrupt the diff — install/configure the real",
    "  dependency instead.",
  ],
}

// ── owned-only env atoms (the install-permitted tail). ──
const R_ENV_OWNED: InstructionAtom = {
  atomId: "R-ENV",
  variantId: "R-ENV#owned",
  authority: "L3_app_env",
  channel: "system.base",
  section: POSTURE,
  order: 80,
  when: { envPosture: ["owned"] },
  // Contradicts BOTH the frozen ("do NOT install") and the default variant —
  // exactly one env posture renders. Disjoint `when.envPosture` guarantees it;
  // the edge makes the conflict-freedom verifier PROVE it (see R-NO-SHIM note).
  conflictsWith: ["R-ENV#frozen", "R-ENV#default"],
  lines: [
    "- [R-ENV-OWNED] You own this environment. Install dependencies, configure",
    "  services, and build tooling as needed (pip/apt/npm/cargo/…). A working",
    "  environment IS part of the deliverable, not an obstacle. Prefer non-interactive",
    "  flags; re-probe after installing; a clean exit code on the verifying command is",
    "  the proof.",
  ],
  provenance: ["RFC jul-2-terminal-bench-levers/01"],
}

const R_INSTALL_THRASH: InstructionAtom = {
  atomId: "R-INSTALL-THRASH",
  variantId: "R-INSTALL-THRASH#owned",
  authority: "L3_app_env",
  channel: "system.base",
  section: POSTURE,
  order: 90,
  when: { envPosture: ["owned"] },
  lines: [
    "- [R-INSTALL-THRASH] If an install or build fails, read the error and diagnose",
    "  (wrong package name, missing index, missing build dep, permissions) before",
    "  retrying — do not re-run the same install command unchanged.",
  ],
}

const R_ENV_DONE: InstructionAtom = {
  atomId: "R-ENV-DONE",
  variantId: "R-ENV-DONE#owned",
  authority: "L3_app_env",
  channel: "system.base",
  section: POSTURE,
  order: 100,
  when: { envPosture: ["owned"] },
  lines: [
    "- [R-ENV-DONE] Configuring the environment is a MEANS, not the goal. Once the",
    "  verifying command exits clean and the deliverable is in place, STOP — do not",
    "  keep installing, configuring, or polishing the environment past what the task",
    "  needs.",
  ],
}

// ── default-only env atom (install permitted, NOT graded). Supersedes frozen
//    R-ENV; distinct from owned (no grading framing). Order 80 → the shim
//    (order 60) precedes it, matching DEFAULT_BASE = [...rails, R-NO-SHIM, R-ENV-LOCAL]. ──
const R_ENV_LOCAL: InstructionAtom = {
  atomId: "R-ENV",
  variantId: "R-ENV#default",
  authority: "L3_app_env",
  channel: "system.base",
  section: POSTURE,
  order: 80,
  when: { envPosture: ["default"] },
  // Contradicts the frozen variant (owned↔default pair is declared on R-ENV#owned).
  conflictsWith: ["R-ENV#frozen"],
  lines: [
    "- [R-ENV-LOCAL] This is the user's OWN machine, not a graded sandbox. You MAY",
    "  install or configure the dependencies the task needs — prefer the project's",
    "  declared dependencies + lockfile and its own package manager (npm / pip / uv /",
    "  cargo, whichever the repo uses). Keep it tidy: prefer a project-local install",
    "  over a global/system-wide change, and do not leave the environment dirtier than",
    "  the task requires.",
  ],
  provenance: ["jul-9 QUANTA_ENV_DEFAULT CLI knob"],
}

// ─────────────────────────────────────────────────────────────────────────
// Verify-strategy atoms — the THIRD axis (jul-4). One of the three fires when
// its `verifyStrategy` axis value is selected; absent strategy fires nothing.
// grader-only is the OPPOSITE posture to reproduce-first / verify-after-edit —
// they are mutually exclusive by being distinct axis values, and grader-only
// additionally SUPPRESSES verify-strategy-adjacent body blocks (Phase 2). The
// `conflictsWith` edges below encode the jul-10 contradiction class so the
// verifier proves they never co-render.
// ─────────────────────────────────────────────────────────────────────────
const R_REPRODUCE_FIRST: InstructionAtom = {
  atomId: "R-REPRODUCE-FIRST",
  variantId: "R-REPRODUCE-FIRST",
  authority: "L1_system",
  channel: "system.base",
  section: VERIFY,
  order: 10,
  when: { verifyStrategy: ["reproduce-first"] },
  conflictsWith: ["R-GRADER-ONLY"],
  lines: [
    "- [R-REPRODUCE-FIRST] Reproduce before you fix. From the issue / task",
    "  description, write the minimal script or command that triggers the reported",
    "  failure and confirm it fails for the stated reason. Make your fix, then RERUN",
    "  that same reproduction and confirm it now passes. Ground the change in an",
    "  observed before→after, not a guess about what the code does. Use only the",
    "  public issue text — do NOT seek any hidden, grader, or reference test.",
  ],
}

const R_VERIFY_AFTER_EDIT: InstructionAtom = {
  atomId: "R-VERIFY-AFTER-EDIT",
  variantId: "R-VERIFY-AFTER-EDIT",
  authority: "L1_system",
  channel: "system.base",
  section: VERIFY,
  order: 10,
  when: { verifyStrategy: ["verify-after-edit"] },
  conflictsWith: ["R-GRADER-ONLY"],
  lines: [
    "- [R-VERIFY-AFTER-EDIT] Verify each change before reporting it done. Run the",
    "  narrowest check that exercises what you changed — the affected file's tests, a",
    "  type-check, or the exact command the user runs — and READ the result. Do not",
    "  claim a change works until you have observed it behave.",
  ],
}

const R_GRADER_ONLY: InstructionAtom = {
  atomId: "R-GRADER-ONLY",
  variantId: "R-GRADER-ONLY",
  authority: "L1_system",
  channel: "system.base",
  section: VERIFY,
  order: 10,
  when: { verifyStrategy: ["grader-only"] },
  // The opposite verify postures must never co-render with hidden-grader mode.
  conflictsWith: ["R-REPRODUCE-FIRST", "R-VERIFY-AFTER-EDIT"],
  lines: [
    "- [R-GRADER-ONLY] SWE hidden-grader mode. An automated grader runs hidden tests",
    "  against ONLY your final source diff; local verification is intentionally disabled.",
    "  Do NOT: run the test suite / pytest / tox / any broad or dependency-install command",
    "  (this checkout lacks test deps — they fail spuriously and only waste turns); create,",
    "  edit, or delete tests, docs, lockfiles, or fixtures; use destructive git (checkout /",
    '  reset / clean / stash / restore); claim "verified / passing / green / done" when no',
    "  permitted check ran; seek any hidden, grader, or reference test.",
    "  Do: read the source before editing; confirm the owning code path by the strongest",
    "  available evidence (lsp_definition / references when reliable, else source reads +",
    "  narrow grep — do not block a small patch just because LSP is unavailable); infer the",
    "  EXACT required behavior (signature, message, return value, edge cases) from the public",
    "  issue and match it precisely; make the smallest isolated source-only change.",
    "  Stop when: the minimal source patch is applied.",
    '  Final: state files changed, behavior changed, and "verification: not run — hidden-',
    '  grader mode forbids local tests; the grader runs them." Do not overclaim.',
  ],
  provenance: ["P6 grader-only exec-mode SSOT", "jul-6 residual-conflict audit"],
}

/** The POSTURE-BASE atom set (env axis) — the migrated `CORE_RULES` /
 *  `OWNED_RULES` / `DEFAULT_BASE` union. Selection is by `when` matcher, so a
 *  posture renders exactly the atoms whose `when.envPosture` admits it plus the
 *  unconditional honesty rails, minus any variant superseded for that ctx. */
export const POSTURE_ATOMS: readonly InstructionAtom[] = [
  R_ENV_FROZEN,
  R_STOP_ENV_FROZEN,
  R_SEARCH_FIRST,
  R_READ_FAILURE,
  R_NO_THRASH,
  R_NO_SHIM_FROZEN,
  R_NO_SHIM_OWNED,
  R_FAILURE_MODE,
  R_ENV_OWNED,
  R_INSTALL_THRASH,
  R_ENV_DONE,
  R_ENV_LOCAL,
]

/** The VERIFY-STRATEGY atom set (third axis). */
export const VERIFY_ATOMS: readonly InstructionAtom[] = [
  R_REPRODUCE_FIRST,
  R_VERIFY_AFTER_EDIT,
  R_GRADER_ONLY,
]

/** The full migrated tool-use-rule atom graph (posture ∪ verify). */
export const TOOL_USE_ATOMS: readonly InstructionAtom[] = [...POSTURE_ATOMS, ...VERIFY_ATOMS]
