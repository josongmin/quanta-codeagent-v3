/**
 * Default mode registry (ADR-0218).
 *
 * Closed table — every {@link AgentMode} arm has EXACTLY one row. The
 * registry's exhaustiveness is asserted by hellgate at build time (an enum
 * arm without a row is a compile / test failure, not a runtime fallback).
 *
 * Profile derivation rationale (per Roo / Codex / Devin convergence):
 *
 *   - architect — heavy reasoning / planning ONLY. Read-only tools; high turn
 *     ceiling because planning often takes many small thoughts. NO edit, NO
 *     shell — the architect proposes diffs as text artifacts; an `editor`
 *     child applies them.
 *   - editor   — narrow mutator. Read + edit + memory; NO shell, NO network,
 *     NO subagent recursion. Low turn ceiling — the editor's job is to take
 *     a concrete diff specification and apply it, not to deliberate.
 *   - debug    — read + shell (for repro / log inspection). NO edit (debug
 *     should propose a fix, not commit it). NO subagent recursion. Medium
 *     turn ceiling.
 *   - tdd      — full mutating surface BUT with explicit ordering
 *     expectation (test-first) encoded in the prompt variant. Tool kinds:
 *     read + edit + shell + memory. NO subagent (TDD loops keep one driver).
 *     High turn ceiling — red-green-refactor cycles are turn-hungry.
 *   - explore  — pure read. Read + lsp + memory. NO edit, NO shell.
 *     Mirrors Codex's `explorer` role; safest of all modes. Medium turn
 *     ceiling (exploration is bounded by attention, not by deliberation).
 *
 * Token caps are conservative defaults — callers may TIGHTEN via the
 * per-request `budget` field but never LOOSEN. The numbers below are
 * power-of-two-ish round figures, not measurements; they exist to bound
 * runaway children, not to optimize cost.
 */

import type { AgentMode, ModeProfile, ToolKind } from "./port"

const FROZEN_KINDS = (kinds: readonly ToolKind[]): readonly ToolKind[] => Object.freeze([...kinds])

/** Read-only default profile table. Adding a new {@link AgentMode} arm
 *  without a row here is caught by the exhaustiveness test in
 *  `tests/unit/subagent-mode-typed-hellgate.test.ts`. */
export const DEFAULT_MODE_REGISTRY: Readonly<Record<AgentMode, ModeProfile>> = Object.freeze({
  architect: Object.freeze({
    mode: "architect",
    systemPromptVariant: "architect",
    allowedToolKinds: FROZEN_KINDS(["read", "lsp", "memory"]),
    maxTurns: 40,
    maxTokens: 128_000,
    rationale: "heavy reasoning / planning; read-only tool surface",
  }),
  editor: Object.freeze({
    mode: "editor",
    systemPromptVariant: "editor",
    allowedToolKinds: FROZEN_KINDS(["read", "edit", "memory"]),
    maxTurns: 12,
    maxTokens: 32_000,
    rationale: "narrow mutator; apply diffs, no deliberation",
  }),
  debug: Object.freeze({
    mode: "debug",
    systemPromptVariant: "debug",
    allowedToolKinds: FROZEN_KINDS(["read", "shell", "lsp", "memory"]),
    maxTurns: 24,
    maxTokens: 64_000,
    rationale: "read + shell repro; propose fix, do not commit",
  }),
  tdd: Object.freeze({
    mode: "tdd",
    systemPromptVariant: "tdd",
    allowedToolKinds: FROZEN_KINDS(["read", "edit", "shell", "memory"]),
    maxTurns: 48,
    maxTokens: 128_000,
    rationale: "red-green-refactor cycle; full mutating surface, no subagent",
  }),
  explore: Object.freeze({
    mode: "explore",
    systemPromptVariant: "explore",
    allowedToolKinds: FROZEN_KINDS(["read", "lsp", "memory"]),
    maxTurns: 20,
    maxTokens: 64_000,
    rationale: "wide-scope read-only inspection",
  }),
})

/** Look up a mode's profile. Returns `null` for unknown modes — no throw,
 *  so the delegation router can surface `errorKind:"mode-missing"` rather
 *  than crash. */
export const lookupModeProfile = (mode: AgentMode): ModeProfile | null => {
  // Object-property access on a frozen record; explicit `in` check so a
  // hostile caller can't bypass the closed set via prototype pollution.
  if (!(mode in DEFAULT_MODE_REGISTRY)) return null
  return DEFAULT_MODE_REGISTRY[mode]
}

/** All known mode keys, frozen — useful for `listModes()` impl. */
export const ALL_MODE_KEYS: readonly AgentMode[] = Object.freeze(
  Object.keys(DEFAULT_MODE_REGISTRY) as AgentMode[],
)
