/**
 * ADR-0538 Phase 2 — the migrated MODE / SESSION NOTICE atoms.
 *
 * The per-mode session notices (ADR-0211) and the brief-mode directive
 * (jun-4-brief-mode RFC) are DYNAMIC per-turn injections that ride the
 * `message.system_reminder` channel (NOT the cached static prefix). Phase 2
 * expresses them as `InstructionAtom`s in the graph so applicability
 * (`when.mode` / `when.brief`) is declarative + inspectable, while the wire
 * shape (`buildTurnContext` splices ONE newline-joined notice string per active
 * facet into the trailing reminder) is preserved exactly.
 *
 * Authority L5_mode — these are the mode/session posture layer. Channel
 * `message.system_reminder` — they are per-turn, so the verifier's
 * static/dynamic-separation check will (correctly) NOT let them land in a
 * `system.*` cached channel.
 *
 * BYTE-EQUIVALENCE: each atom's `lines` are the EXACT prior notice text
 * (imported from `prompt-body.ts`, split back into lines from the
 * newline-joined const), so `buildTurnContext`'s `notice` string per mode is
 * unchanged.
 *
 * Slice boundary: pure text data + declarative conditions. No `@/llm`, `@/tool`.
 */

import {
  ARCHITECT_NOTICE,
  AUDIT_NOTICE,
  BRIEF_NOTICE,
  EDITOR_NOTICE,
  PLAN_NOTICE,
  REVIEW_NOTICE,
} from "../prompt-body"
import type { InstructionAtom } from "./types"

// SAME section as the dynamic-content atoms (`atoms-dynamic.ts`): the reminder is
// assembled by ONE `selectAtoms([...NOTICE_ATOMS, ...DYNAMIC_ATOMS])` call, and
// `selectAtoms` sorts by (section, order) — so notices must share the dynamic
// section for their `order` (104/106, between cwd=102 and directives=110) to
// interleave correctly instead of section-grouping to the end.
const NOTICE = "dynamic.reminder"
const REMINDER = "message.system_reminder" as const

/** The mode-notice consts are newline-joined strings (the wire shape
 *  `buildTurnContext` splices). Atoms carry `lines`, so split back to lines —
 *  `renderNoticeAtom` re-joins with `\n`, reproducing the exact const. */
const toLines = (notice: string): readonly string[] => notice.split("\n")

const PLAN_NOTICE_ATOM: InstructionAtom = {
  atomId: "NOTICE-PLAN",
  variantId: "NOTICE-PLAN",
  authority: "L5_mode",
  channel: REMINDER,
  section: NOTICE,
  order: 104,
  when: { mode: ["plan"] },
  lines: toLines(PLAN_NOTICE),
  provenance: ["ADR-0211 mode notices"],
}
const REVIEW_NOTICE_ATOM: InstructionAtom = {
  atomId: "NOTICE-REVIEW",
  variantId: "NOTICE-REVIEW",
  authority: "L5_mode",
  channel: REMINDER,
  section: NOTICE,
  order: 104,
  when: { mode: ["review"] },
  lines: toLines(REVIEW_NOTICE),
  provenance: ["ADR-0211 mode notices"],
}
const AUDIT_NOTICE_ATOM: InstructionAtom = {
  atomId: "NOTICE-AUDIT",
  variantId: "NOTICE-AUDIT",
  authority: "L5_mode",
  channel: REMINDER,
  section: NOTICE,
  order: 104,
  when: { mode: ["audit"] },
  lines: toLines(AUDIT_NOTICE),
  provenance: ["ADR-0211 mode notices"],
}
// `architect` / `editor` are first-class members of the prompt-graph
// `AgentMode` union (widened in Phase 2), so their notice atoms declare a clean
// `when.mode` facet — no casts.
const ARCHITECT_NOTICE_ATOM: InstructionAtom = {
  atomId: "NOTICE-ARCHITECT",
  variantId: "NOTICE-ARCHITECT",
  authority: "L5_mode",
  channel: REMINDER,
  section: NOTICE,
  order: 104,
  when: { mode: ["architect"] },
  lines: toLines(ARCHITECT_NOTICE),
  provenance: ["ADR-0211 architect read-only posture"],
}
const EDITOR_NOTICE_ATOM: InstructionAtom = {
  atomId: "NOTICE-EDITOR",
  variantId: "NOTICE-EDITOR",
  authority: "L5_mode",
  channel: REMINDER,
  section: NOTICE,
  order: 104,
  when: { mode: ["editor"] },
  lines: toLines(EDITOR_NOTICE),
  provenance: ["ADR-0211 editor minimal-diff posture"],
}
const BRIEF_NOTICE_ATOM: InstructionAtom = {
  atomId: "NOTICE-BRIEF",
  variantId: "NOTICE-BRIEF",
  authority: "L5_mode",
  channel: REMINDER,
  section: NOTICE,
  order: 106,
  when: { brief: true },
  lines: toLines(BRIEF_NOTICE),
  provenance: ["jun-4-brief-mode RFC §4.2/§8 R1"],
}

/** The mode-notice atom set. `buildTurnContext` selects the one whose `when.mode`
 *  matches the effective mode (at most one) and splices its re-joined lines as
 *  the mode notice — byte-identical to the prior `modeNotice(mode)` lookup. */
export const MODE_NOTICE_ATOMS: readonly InstructionAtom[] = [
  PLAN_NOTICE_ATOM,
  REVIEW_NOTICE_ATOM,
  AUDIT_NOTICE_ATOM,
  ARCHITECT_NOTICE_ATOM,
  EDITOR_NOTICE_ATOM,
]

/** The brief-mode directive atom (`when.brief:true`). Separate export because it
 *  composes ADDITIVELY with (not exclusive to) the mode notice. */
export const BRIEF_NOTICE_ATOM_EXPORT: InstructionAtom = BRIEF_NOTICE_ATOM

/** All notice atoms (mode notices ∪ brief). */
export const NOTICE_ATOMS: readonly InstructionAtom[] = [...MODE_NOTICE_ATOMS, BRIEF_NOTICE_ATOM]

/** Render a single notice atom's lines back to the newline-joined wire string
 *  (the shape `buildTurnContext` splices). Exposed so the composer derives the
 *  mode notice + brief notice from the atoms, not from parallel consts. */
export const renderNoticeAtom = (atom: InstructionAtom): string => atom.lines.join("\n")
