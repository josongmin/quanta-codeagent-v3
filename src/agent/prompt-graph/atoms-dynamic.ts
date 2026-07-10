/**
 * ADR-0538 Phase 3 — the migrated DYNAMIC-content atoms.
 *
 * The per-turn `<system-reminder>` block (`buildDynamicContext`) carries content
 * that is per-turn DATA, not static rule text: today's date, cwd, the assistant
 * language hint, the env/build block, the repo-local rules body, the memory
 * recall, and the soft task-budget line. Phase 3 expresses each as an
 * `InstructionAtom` on the `message.system_reminder` channel so applicability is
 * the declarative `when` matcher (presence facets over the per-turn surface) and
 * observability is a fired-atom manifest — WITHOUT smuggling a render closure
 * onto the atom.
 *
 * WHAT THESE ATOMS ARE (and are NOT — honest scope):
 *   - They are the DECLARATIVE APPLICABILITY + OBSERVABILITY manifest of the
 *     per-turn reminder: each atom's `when` says WHEN its block rides, and its
 *     `contentKey` NAMES which block it is, so the compiler can report a
 *     fired-atom manifest for the reminder channel (`byChannel`).
 *   - They do NOT yet PRODUCE the reminder wire text. That text is assembled by
 *     the leaf renderers in {@link buildDynamicContext} (date/cwd/env/repo/…).
 *     There is no `contentByKey` RESOLVER wiring these atoms to the wire — the
 *     graph is authoritative for the reminder's APPLICABILITY + manifest, not (yet)
 *     for its bytes. Making the graph author the reminder text too (a pure
 *     `contentByKey(input, now)` the assembler folds over the selected atoms, so
 *     `buildDynamicContext` DERIVES from the atoms) is the natural next step —
 *     deferred because it must stay byte-identical over the whole reminder.
 *   - Because there are TWO expressions of "is this block present" — each atom's
 *     `when` here, and the matching `if (...)` in `buildDynamicContext` — they
 *     MUST agree. That correspondence is the drift risk; a drift-guard hellgate
 *     pins `manifest reminder atom fired ⟺ its block text present in the wire`
 *     (`compile-artifact-hellgate.test.ts`), so the shadow cannot silently
 *     diverge.
 *
 * PURITY CONTRACT (ADR-0538 §KEY-TRANSFORM — dynamic atoms):
 *   - `when` stays the DECLARATIVE {@link AtomMatcher} (e.g. `hasRepoRules`,
 *     `hasMemorySummary`, `hasLanguageHint`/`hasImages`) — applicability is
 *     inspectable + exhaustively verifiable, never a `(ctx)=>boolean`.
 *   - the atom carries a STABLE {@link InstructionAtom.contentKey} LABEL and NO
 *     text: no clock / IO / closure capture lives on the atom.
 *   - `lines` is EMPTY for a dynamic atom (its wire text is per-turn DATA the
 *     leaf renderer produces, not a static literal).
 *
 * CHANNEL: `message.system_reminder` (per-turn) — the verifier's static/dynamic
 * separation check would (correctly) reject any of these on a cached `system.*`
 * channel. AUTHORITY: mixed — `date`/`cwd`/`env` are L2/L3 host-static, repo
 * rules L6, memory/working-state L9, task-budget L2. Placed on the dynamic
 * channel so authority-placement stays clean.
 *
 * ORDER: mirrors the `buildDynamicContext` `parts[]` sequence exactly, so the
 * fired-atom manifest orders the reminder the way it is actually assembled.
 *
 * Slice boundary: pure text-free data + declarative conditions + stable keys.
 * No `@/llm`, no `@/tool`, no renderers imported (the compiler owns rendering).
 */

import type { InstructionAtom } from "./types"

const REMINDER = "message.system_reminder" as const
const SECTION = "dynamic.reminder"

/** The stable content-key set for the dynamic reminder segments. The compiler's
 *  `contentByKey` resolver produces the per-turn text for each. Exported so the
 *  compiler + the verifier reference ONE closed set (drift guard). */
export type DynamicContentKey =
  | "date"
  | "cwd"
  | "directives"
  | "language-hint"
  | "env-block"
  | "repo-rules"
  | "glob-rules"
  | "active-skills"
  | "working-state"
  | "memory-context"
  | "hook-context-tail"
  | "task-budget"

const dyn = (
  key: DynamicContentKey,
  order: number,
  when: InstructionAtom["when"],
  authority: InstructionAtom["authority"],
  provenance?: readonly string[],
): InstructionAtom => ({
  atomId: `DYN-${key}`,
  variantId: `DYN-${key}`,
  authority,
  channel: REMINDER,
  section: SECTION,
  order,
  lines: [], // per-turn DATA — resolved by the compiler via `contentKey`.
  contentKey: key,
  ...(when !== undefined ? { when } : {}),
  ...(provenance !== undefined ? { provenance } : {}),
})

// ── Ordered to mirror `buildDynamicContext`'s `parts[]` assembly. The mode /
//    brief NOTICE atoms (atoms-notices.ts) ride the SAME channel at their own
//    orders (10/20); the compiler assembles date → cwd → notices → brief →
//    directives → langhint → env → repo → glob → skills → working-state →
//    memory → hook-tail → task-budget. Orders here are AFTER the notice orders
//    (10/20) so the manifest sequence is coherent. ──

/** Always-on: today's date line (clock injected by the compiler's pure `now`). */
const A_DATE = dyn("date", 100, undefined, "L2_runtime", ["ADR-0078 determinism-safe date"])
/** Always-on: `Working directory: <cwd>`. */
const A_CWD = dyn("cwd", 102, undefined, "L2_runtime")
/** §5 prompt-directive bundle — resolved from runtimeConfig knobs (default-OFF).
 *  Fires ONLY when the selection is non-empty (`hasDirectives`), so the manifest
 *  never reports a zero-byte directive turn. */
const A_DIRECTIVES = dyn("directives", 110, { hasDirectives: true }, "L2_runtime", [
  "jun-06 §5 directive bundle",
])
/** N1 assistant-language notice (default-OFF `QUANTA_LANG_DETECT`). */
const A_LANGUAGE_HINT = dyn("language-hint", 120, { hasLanguageHint: true }, "L2_runtime", [
  "N1 language-hint",
])
/** ADR-0397 env / build block (host-static authority, above repo rules). */
const A_ENV_BLOCK = dyn("env-block", 130, { hasEnvBlock: true }, "L3_app_env", [
  "ADR-0397 env block",
])
/** Repo-local rules body — ONLY when NOT already in the static project_md
 *  section (the compiler passes `hasRepoRulesDynamic`, true only when the repo
 *  rules are NOT hoisted to the cached prefix). */
const A_REPO_RULES = dyn("repo-rules", 140, { hasRepoRulesDynamic: true }, "L6_repo", [
  "Codex repo-local-rule-ingestion",
])
/** File-scoped glob rules (Cursor `.cursor/rules` parity). */
const A_GLOB_RULES = dyn("glob-rules", 150, { hasGlobRules: true }, "L6_repo")
/** Active-skills catalogue + trigger rules. */
const A_ACTIVE_SKILLS = dyn("active-skills", 160, { hasActiveSkills: true }, "L7_skill", [
  "Codex skills-audit",
])
/** Per-turn working state (Codex memory L3 scratchpad). */
const A_WORKING_STATE = dyn("working-state", 170, { hasWorkingState: true }, "L9_working_state")
/** Memory recall body (trust-ladder routing hint). */
const A_MEMORY = dyn("memory-context", 180, { hasMemorySummary: true }, "L9_working_state")
/** ADR-0133 hook-context after-system tail. */
const A_HOOK_TAIL = dyn("hook-context-tail", 190, { hasHookInjects: true }, "L2_runtime", [
  "ADR-0133 hook prompt inject",
])
/** jun-02 soft task-budget guidance (orthogonal to the hard breaker). */
const A_TASK_BUDGET = dyn("task-budget", 200, { hasTaskBudget: true }, "L2_runtime", [
  "jun-02 soft task budget",
])

/**
 * The dynamic-content atom set (ordered). Every atom rides
 * `message.system_reminder` with a `contentKey`; the compiler resolves each key
 * to per-turn text via a pure lookup and assembles them in order (interleaved
 * with the notice atoms). Applicability is the declarative `when` matcher.
 */
export const DYNAMIC_ATOMS: readonly InstructionAtom[] = [
  A_DATE,
  A_CWD,
  A_DIRECTIVES,
  A_LANGUAGE_HINT,
  A_ENV_BLOCK,
  A_REPO_RULES,
  A_GLOB_RULES,
  A_ACTIVE_SKILLS,
  A_WORKING_STATE,
  A_MEMORY,
  A_HOOK_TAIL,
  A_TASK_BUDGET,
]
