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
 * WHAT THESE ATOMS ARE — the graph IS authoritative for the reminder:
 *   - Each atom's `when` says WHEN its block rides; its `contentKey` NAMES which
 *     block it is. The compiler's `contentByKey` RESOLVER (in `prompt.ts`) maps
 *     the key to per-turn wire text via the leaf renderers, and
 *     `resolveReminderBlocks` folds over the ONE ordered atom selection to produce
 *     BOTH the wire (`buildDynamicContext`) AND the fired-atom manifest.
 *   - Because the wire and the manifest derive from that SAME selection, they
 *     CANNOT drift: an atom is "fired" IFF it produced wire text. There is no
 *     longer a parallel hand-rolled sequence to disagree with (the earlier
 *     observability-shadow, closed by the `contentByKey` migration). A drift-guard
 *     hellgate (`compile-artifact-hellgate.test.ts`, case-set == DYNAMIC_ATOMS)
 *     additionally pins `manifest atom fired ⟺ its block text in the wire` so a
 *     new key without a resolver case fails loudly.
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

/** The stable content-key set for the dynamic reminder segments — each names ONE
 *  block of the per-turn reminder. The compiler's `contentByKey` resolver
 *  (`prompt.ts`) maps the key to the block's per-turn wire text via the leaf
 *  renderers. Exported so the compiler + the verifier reference ONE closed set
 *  (drift guard: the resolver switch + `resolveReminderBlocks` cover this set). */
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
  lines: [], // per-turn DATA — the compiler's `contentByKey` resolver produces the text from this key.
  contentKey: key,
  ...(when !== undefined ? { when } : {}),
  ...(provenance !== undefined ? { provenance } : {}),
})

// ── Ordered to mirror the reminder assembly. The mode / brief NOTICE atoms
//    (atoms-notices.ts) ride the SAME channel AND section ("dynamic.reminder") at
//    orders 104/106, so ONE `selectAtoms([...NOTICE, ...DYNAMIC])` sort produces:
//    date(100) → cwd(102) → mode-notice(104) → brief(106) → directives(110) →
//    langhint(120) → env(130) → repo(140) → glob(150) → skills(160) →
//    working-state(170) → memory(180) → hook-tail(190) → task-budget(200). The
//    compiler resolves each block from this ONE selection (wire + manifest), so
//    they cannot drift. ──

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
 * `message.system_reminder` with a `contentKey`; the compiler's `contentByKey`
 * resolver produces each block's per-turn text (via the leaf renderers) and
 * `resolveReminderBlocks` folds over this ordered selection — interleaved with the
 * notice atoms — to assemble BOTH the wire and the manifest. Applicability is the
 * declarative `when` matcher.
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
