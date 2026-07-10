/**
 * ADR-0538 Phase 2 — the migrated FLAT-BODY atoms (the SSOT for the monolithic
 * tail that `buildSystemPrompt` used to splice as `BODY_AFTER_PERSONA` +
 * `BODY_AFTER_PROMPT_PACK`).
 *
 * This file makes the instruction graph AUTHORITATIVE over the body: the flat
 * `prompt-body.ts` consts are re-expressed as `InstructionAtom`s, and
 * `buildSystemPrompt` derives its body via `renderAtoms(...)` — there is no
 * parallel copy. Applicability that used to be `withoutBlocks` string surgery
 * (grader-only suppression) is now `when.verifyStrategy:{not:["grader-only"]}`
 * on the individual suppressed sub-blocks; the read-only-vs-code-change
 * completion bar is now a `when.mode` split.
 *
 * BYTE-EQUIVALENCE: every atom's `lines` are the EXACT prior literal text (the
 * `prompt-body.ts` consts, imported or sliced — never re-typed) and the `order`
 * numbers reproduce the prior render sequence, so for every reachable
 * posture×pack×verify×mode combination the joined body is byte-identical to the
 * pre-migration output — EXCEPT the one intentional new output: a distinct
 * read-only completion-bar variant under plan/review/audit/architect.
 *
 * Slice boundary: pure text data + declarative conditions. No `@/llm`, `@/tool`.
 */

import {
  BODY_AFTER_PERSONA_BUDGET_DISCIPLINE,
  BODY_AFTER_PERSONA_DURABLE_STATE,
  BODY_AFTER_PERSONA_EVIDENCE_AND_TRUST,
  BODY_AFTER_PERSONA_GIT_POSTURE,
  BODY_AFTER_PERSONA_INTERNAL_VOCABULARY,
  BODY_AFTER_PERSONA_OPERATING_PRINCIPLES,
  BODY_AFTER_PERSONA_POLICY_STACK,
  BODY_AFTER_PERSONA_PRODUCTION_CODE_CONDUCT,
  BODY_AFTER_PERSONA_TOOL_FAILURES_AND_EXPLORATION,
  BODY_AFTER_PERSONA_TOOL_ROUTING,
  BODY_AFTER_PROMPT_PACK_COMPLETION_BAR,
  BODY_AFTER_PROMPT_PACK_EXPLORATORY_QUESTIONS,
  BODY_AFTER_PROMPT_PACK_HONESTY_RAIL,
  BODY_AFTER_PROMPT_PACK_REPORTING_SHAPE,
  BODY_AFTER_PROMPT_PACK_TRUST_AND_INPUTS,
  BODY_AFTER_PROMPT_PACK_VERIFICATION_REPORT,
  BODY_AFTER_PROMPT_PACK_VISION_PRIORITY,
  BODY_ANALYSIS_MULTISTEP,
  BODY_REPRO_REQUIRED,
  BODY_VALIDATION_BUDGET,
  BODY_VERIFY_AFTER_EDIT_DISCIPLINE,
} from "../prompt-body"
import type { AtomMatcher, InstructionAtom } from "./types"

// ─────────────────────────────────────────────────────────────────────────
// Channels + sections. The whole static body rides `system.base`; two section
// labels group it: `body.after_persona` (policy stack → tool routing, rendered
// BEFORE the posture/task/verify axes) and `body.after_pack` (vision → completion
// bar, rendered AFTER them). `buildSystemPrompt` renders each group at its slot,
// so the two are never interleaved.
// ─────────────────────────────────────────────────────────────────────────
const AFTER_PERSONA = "body.after_persona"
const AFTER_PACK = "body.after_pack"

/** grader-only SUPPRESSION facet — a sub-block that presupposes local
 *  verification / repro / doc writes (which the SWE hidden-grader posture
 *  forbids) fires in EVERY verify strategy EXCEPT grader-only. This replaces the
 *  `withoutBlocks(...)` + `GRADER_ONLY_SUPPRESSED_*` string surgery. */
const NOT_GRADER: AtomMatcher = { verifyStrategy: { not: ["grader-only"] } }

/** Read-only task modes (ADR-0211): the deliverable is a plan/findings/design,
 *  NOT a code change. `editor` is EXCLUDED — it mutates, so it takes the
 *  code-change completion bar. */
const READ_ONLY_MODES = ["plan", "review", "audit", "architect"] as const

// ─────────────────────────────────────────────────────────────────────────
// Split helper — find a contiguous sub-block inside a section const and return
// the [head, tail] literal halves around it. Used ONLY to derive the pre/post
// literal spans around an embedded grader-suppressed sub-block WITHOUT re-typing
// the surrounding text (byte-equivalence). Throws if the block is not a
// contiguous subsequence (drift guard — same fail-loud posture as the deleted
// `withoutBlocks`).
// ─────────────────────────────────────────────────────────────────────────
const splitAround = (
  section: readonly string[],
  block: readonly string[],
): { head: readonly string[]; tail: readonly string[] } => {
  for (let i = 0; i + block.length <= section.length; i++) {
    let match = true
    for (let j = 0; j < block.length; j++) {
      if (section[i + j] !== block[j]) {
        match = false
        break
      }
    }
    if (match) {
      return { head: section.slice(0, i), tail: section.slice(i + block.length) }
    }
  }
  throw new Error(
    `atoms-body.splitAround: sub-block not found in section (drifted?): ${JSON.stringify(block[0])}`,
  )
}

// ── OPERATING_PRINCIPLES carries TWO embedded grader-suppressed sub-blocks
//    (verify-after-edit discipline, then repro-required). Split around each so
//    the surrounding literal spans stay byte-identical. ──
const OP_A = splitAround(BODY_AFTER_PERSONA_OPERATING_PRINCIPLES, BODY_VERIFY_AFTER_EDIT_DISCIPLINE)
// OP_A.head = "Operating principles:" … "imports/manifests before assuming…"
// OP_A.tail = [tool-fails bullet] + REPRO_REQUIRED + rest(+trailing blank)
const OP_B = splitAround(OP_A.tail, BODY_REPRO_REQUIRED)
// OP_B.head = the "When a tool fails" bullet (between verify-after-edit and repro)
// OP_B.tail = the remainder of Operating principles (through the trailing blank)

// ── BUDGET_DISCIPLINE carries ONE embedded grader-suppressed sub-block
//    (validation budget). ──
const BUDGET = splitAround(BODY_AFTER_PERSONA_BUDGET_DISCIPLINE, BODY_VALIDATION_BUDGET)

// ── TOOL_FAILURES carries ONE embedded grader-suppressed sub-block
//    (analysis-multistep). ──
const TOOLFAIL = splitAround(
  BODY_AFTER_PERSONA_TOOL_FAILURES_AND_EXPLORATION,
  BODY_ANALYSIS_MULTISTEP,
)

// ─────────────────────────────────────────────────────────────────────────
// AFTER-PERSONA atoms (policy stack → tool routing). order 100..200.
// ─────────────────────────────────────────────────────────────────────────
const A_POLICY_STACK: InstructionAtom = {
  atomId: "BODY-POLICY-STACK",
  variantId: "BODY-POLICY-STACK",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 100,
  lines: BODY_AFTER_PERSONA_POLICY_STACK,
}

// Operating principles, in FIVE atoms so the two grader-suppressed sub-blocks
// slot exactly where they did inline (order 110..118, dense so nothing else
// interleaves).
const A_OP_HEAD: InstructionAtom = {
  atomId: "BODY-OPERATING-PRINCIPLES",
  variantId: "BODY-OPERATING-PRINCIPLES#head",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 110,
  lines: OP_A.head,
}
const A_OP_VERIFY_AFTER_EDIT: InstructionAtom = {
  atomId: "BODY-VERIFY-AFTER-EDIT-DISCIPLINE",
  variantId: "BODY-VERIFY-AFTER-EDIT-DISCIPLINE",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 112,
  when: NOT_GRADER,
  lines: BODY_VERIFY_AFTER_EDIT_DISCIPLINE,
  provenance: ["jul-6 residual-conflict audit R3"],
}
const A_OP_TOOL_FAIL_BULLET: InstructionAtom = {
  atomId: "BODY-OPERATING-PRINCIPLES",
  variantId: "BODY-OPERATING-PRINCIPLES#mid",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 114,
  lines: OP_B.head,
}
const A_OP_REPRO_REQUIRED: InstructionAtom = {
  atomId: "BODY-REPRO-REQUIRED",
  variantId: "BODY-REPRO-REQUIRED",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 116,
  when: NOT_GRADER,
  lines: BODY_REPRO_REQUIRED,
  provenance: ["jul-3 strategy-audit A3 defect-gated repro"],
}
const A_OP_TAIL: InstructionAtom = {
  atomId: "BODY-OPERATING-PRINCIPLES",
  variantId: "BODY-OPERATING-PRINCIPLES#tail",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 118,
  lines: OP_B.tail,
  provenance: ["ADR-0067 user-intent discipline"],
}

const A_INTERNAL_VOCAB: InstructionAtom = {
  atomId: "BODY-INTERNAL-VOCABULARY",
  variantId: "BODY-INTERNAL-VOCABULARY",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 130,
  lines: BODY_AFTER_PERSONA_INTERNAL_VOCABULARY,
  provenance: ["ADR-0067", "Codex L26/L217"],
}
const A_PRODUCTION_CONDUCT: InstructionAtom = {
  atomId: "BODY-PRODUCTION-CODE-CONDUCT",
  variantId: "BODY-PRODUCTION-CODE-CONDUCT",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 140,
  lines: BODY_AFTER_PERSONA_PRODUCTION_CODE_CONDUCT,
}
const A_GIT_POSTURE: InstructionAtom = {
  atomId: "BODY-GIT-POSTURE",
  variantId: "BODY-GIT-POSTURE",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 150,
  lines: BODY_AFTER_PERSONA_GIT_POSTURE,
  provenance: ["Codex §18.2/§18.4/§18.5"],
}
const A_EVIDENCE_TRUST: InstructionAtom = {
  atomId: "BODY-EVIDENCE-AND-TRUST",
  variantId: "BODY-EVIDENCE-AND-TRUST",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 160,
  lines: BODY_AFTER_PERSONA_EVIDENCE_AND_TRUST,
}
const A_DURABLE_STATE: InstructionAtom = {
  atomId: "BODY-DURABLE-STATE",
  variantId: "BODY-DURABLE-STATE",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 170,
  when: NOT_GRADER,
  lines: BODY_AFTER_PERSONA_DURABLE_STATE,
  provenance: ["jul-6 residual-conflict audit — grader-only forbids doc writes"],
}
const A_BUDGET_HEAD: InstructionAtom = {
  atomId: "BODY-BUDGET-DISCIPLINE",
  variantId: "BODY-BUDGET-DISCIPLINE#head",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 180,
  lines: BUDGET.head,
}
const A_VALIDATION_BUDGET: InstructionAtom = {
  atomId: "BODY-VALIDATION-BUDGET",
  variantId: "BODY-VALIDATION-BUDGET",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 182,
  when: NOT_GRADER,
  lines: BODY_VALIDATION_BUDGET,
  provenance: ["jul-6 residual-conflict audit — no local run under grader-only"],
}
const A_BUDGET_TAIL: InstructionAtom = {
  atomId: "BODY-BUDGET-DISCIPLINE",
  variantId: "BODY-BUDGET-DISCIPLINE#tail",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 184,
  lines: BUDGET.tail,
}
const A_TOOLFAIL_HEAD: InstructionAtom = {
  atomId: "BODY-TOOL-FAILURES-AND-EXPLORATION",
  variantId: "BODY-TOOL-FAILURES-AND-EXPLORATION#head",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 190,
  lines: TOOLFAIL.head,
  provenance: ["ADR-0062", "Codex SKILL.md L220/L254/L353"],
}
const A_ANALYSIS_MULTISTEP: InstructionAtom = {
  atomId: "BODY-ANALYSIS-MULTISTEP",
  variantId: "BODY-ANALYSIS-MULTISTEP",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 192,
  when: NOT_GRADER,
  lines: BODY_ANALYSIS_MULTISTEP,
  provenance: ["jul-6 residual-conflict audit — over-exploration framing"],
}
const A_TOOLFAIL_TAIL: InstructionAtom = {
  atomId: "BODY-TOOL-FAILURES-AND-EXPLORATION",
  variantId: "BODY-TOOL-FAILURES-AND-EXPLORATION#tail",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 194,
  lines: TOOLFAIL.tail,
}
const A_TOOL_ROUTING: InstructionAtom = {
  atomId: "BODY-TOOL-ROUTING",
  variantId: "BODY-TOOL-ROUTING",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PERSONA,
  order: 200,
  lines: BODY_AFTER_PERSONA_TOOL_ROUTING,
  provenance: ["ADR-0410 few-shot anchor"],
}

/** The AFTER-PERSONA body atom set (policy stack → tool routing), rendered
 *  BEFORE the posture/task/verify axes. */
export const BODY_AFTER_PERSONA_ATOMS: readonly InstructionAtom[] = [
  A_POLICY_STACK,
  A_OP_HEAD,
  A_OP_VERIFY_AFTER_EDIT,
  A_OP_TOOL_FAIL_BULLET,
  A_OP_REPRO_REQUIRED,
  A_OP_TAIL,
  A_INTERNAL_VOCAB,
  A_PRODUCTION_CONDUCT,
  A_GIT_POSTURE,
  A_EVIDENCE_TRUST,
  A_DURABLE_STATE,
  A_BUDGET_HEAD,
  A_VALIDATION_BUDGET,
  A_BUDGET_TAIL,
  A_TOOLFAIL_HEAD,
  A_ANALYSIS_MULTISTEP,
  A_TOOLFAIL_TAIL,
  A_TOOL_ROUTING,
]

// ─────────────────────────────────────────────────────────────────────────
// AFTER-PACK atoms (vision → completion bar). order 300..400. Rendered AFTER
// the posture/task/verify axes.
// ─────────────────────────────────────────────────────────────────────────

// VISION_PRIORITY: a leading blank + the vision body. grader-only drops the
// vision body but KEEPS the leading blank (the prior `.slice(1)` behavior), so
// the separator before the next section survives. Split into two atoms.
//
// NOTE (ADR-0538 §KEY-TRANSFORM 3): images are PER-TURN, so we do NOT gate the
// vision atom on `hasImages` at the static-prefix level — that would drop the
// rule from the cached prefix on image-less turns and break the wire (the
// prefix must be image-independent). The atom is kept ALWAYS-ON (its only gate
// is grader-only suppression), preserving current wire behavior. FLAG: when the
// per-turn dynamic channel migrates, a `hasImages`-gated dynamic vision variant
// could replace this — not at the static layer.
const VISION_BLANK = BODY_AFTER_PROMPT_PACK_VISION_PRIORITY.slice(0, 1)
const VISION_BODY = BODY_AFTER_PROMPT_PACK_VISION_PRIORITY.slice(1)

const A_VISION_BLANK: InstructionAtom = {
  atomId: "BODY-VISION-PRIORITY",
  variantId: "BODY-VISION-PRIORITY#blank",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PACK,
  order: 300,
  lines: VISION_BLANK,
}
const A_VISION_BODY: InstructionAtom = {
  atomId: "BODY-VISION-PRIORITY",
  variantId: "BODY-VISION-PRIORITY#body",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PACK,
  order: 302,
  when: NOT_GRADER,
  lines: VISION_BODY,
  provenance: ["ADR-0538 §KEY-TRANSFORM 3 — always-on to preserve per-turn wire"],
}
const A_HONESTY_RAIL: InstructionAtom = {
  atomId: "BODY-HONESTY-RAIL",
  variantId: "BODY-HONESTY-RAIL",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PACK,
  order: 310,
  lines: BODY_AFTER_PROMPT_PACK_HONESTY_RAIL,
  provenance: ["ADR-0067 verification-claim filter"],
}
const A_TRUST_AND_INPUTS: InstructionAtom = {
  atomId: "BODY-TRUST-AND-INPUTS",
  variantId: "BODY-TRUST-AND-INPUTS",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PACK,
  order: 320,
  lines: BODY_AFTER_PROMPT_PACK_TRUST_AND_INPUTS,
}
const A_EXPLORATORY_QUESTIONS: InstructionAtom = {
  atomId: "BODY-EXPLORATORY-QUESTIONS",
  variantId: "BODY-EXPLORATORY-QUESTIONS",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PACK,
  order: 330,
  lines: BODY_AFTER_PROMPT_PACK_EXPLORATORY_QUESTIONS,
}
const A_REPORTING_SHAPE: InstructionAtom = {
  atomId: "BODY-REPORTING-SHAPE",
  variantId: "BODY-REPORTING-SHAPE",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PACK,
  order: 340,
  lines: BODY_AFTER_PROMPT_PACK_REPORTING_SHAPE,
}
const A_VERIFICATION_REPORT: InstructionAtom = {
  atomId: "BODY-VERIFICATION-REPORT",
  variantId: "BODY-VERIFICATION-REPORT",
  authority: "L1_system",
  channel: "system.base",
  section: AFTER_PACK,
  order: 350,
  when: NOT_GRADER,
  lines: BODY_AFTER_PROMPT_PACK_VERIFICATION_REPORT,
  provenance: ["jul-6 residual-conflict audit R4 — presupposes a local run"],
}

// COMPLETION_BAR split (ADR-0538 §KEY-TRANSFORM 2). The prior single block
// framed BOTH a code-change bar AND a one-line "read-only mode ⇒ deliverable is
// the plan/findings/design" aside. It is split into TWO conflicting variants:
//   - code-change (order 360): fires in code-change modes (NOT plan/review/audit
//     /architect) AND NOT grader-only (grader suppressed the whole bar before).
//     Keeps the env-blocked escape hatch. BYTE-IDENTICAL to the prior block for
//     the default/editor code-change path.
//   - read-only (order 360): fires under plan/review/audit/architect — a
//     completion bar whose deliverable is the plan/findings/design, not a code
//     change.
// They `conflictsWith` each other (never co-render) and their `when.mode`
// facets are disjoint, so exactly one fires per ctx.
//
// ⚠️ FORWARD SEAM (not yet wired to the wire): the read-only variant renders
// only when `buildSystemPrompt` is called with a read-only `mode` — but (a) NO
// composition-root caller threads `mode` into `buildSystemPrompt` today (only
// `envPosture`/`verifyStrategy` are threaded, see `surface-profile.ts` /
// `default-builder.ts`), and (b) the session cache path calls
// `buildSystemPrompt()` bare, so the cached static prefix is mode-INDEPENDENT
// and always renders the code-change variant. So this split is BYTE-IDENTICAL
// today (the read-only variant never ships) and the atom exists as the SEAM +
// the verifier's mode-crossed coverage/conflict proof. Wiring it needs EITHER a
// mode-aware static cache key (cost: ×mode cardinality + mid-session mode
// changes churn the prefix) OR — cleaner — moving the read-only bar onto the
// DYNAMIC reminder channel where the mode NOTICE already rides. Deferred
// (measure-first): the mode notice already tells a read-only turn its
// deliverable is the plan/findings, so the marginal value is unmeasured.
const A_COMPLETION_CODE_CHANGE: InstructionAtom = {
  atomId: "BODY-COMPLETION-BAR",
  variantId: "BODY-COMPLETION-BAR#code-change",
  authority: "L5_mode",
  channel: "system.base",
  section: AFTER_PACK,
  order: 360,
  when: { mode: { not: [...READ_ONLY_MODES] }, verifyStrategy: { not: ["grader-only"] } },
  conflictsWith: ["BODY-COMPLETION-BAR#read-only"],
  // SSOT: the code-change bar IS the pre-migration completion-bar text verbatim —
  // source it from the one const (`prompt-body.ts`) rather than re-typing it, so
  // there is a single place the wire text lives (byte-identical by construction).
  lines: BODY_AFTER_PROMPT_PACK_COMPLETION_BAR,
}
const A_COMPLETION_READ_ONLY: InstructionAtom = {
  atomId: "BODY-COMPLETION-BAR",
  variantId: "BODY-COMPLETION-BAR#read-only",
  authority: "L5_mode",
  channel: "system.base",
  section: AFTER_PACK,
  order: 360,
  when: { mode: [...READ_ONLY_MODES] },
  conflictsWith: ["BODY-COMPLETION-BAR#code-change"],
  lines: [
    "Completion bar: finish only when the deliverable is genuinely done. In this",
    "read-only mode the deliverable is the plan / findings / design, NOT a code",
    "change — you produce it without mutating the repo. Do not imply success you did",
    "not verify. Then stop calling tools and give a brief summary of what you",
    "produced.",
  ],
  provenance: ["ADR-0538 §KEY-TRANSFORM 2 — intentional read-only completion split"],
}

/** The AFTER-PACK body atom set (vision → completion bar), rendered AFTER the
 *  posture/task/verify axes. */
export const BODY_AFTER_PROMPT_PACK_ATOMS: readonly InstructionAtom[] = [
  A_VISION_BLANK,
  A_VISION_BODY,
  A_HONESTY_RAIL,
  A_TRUST_AND_INPUTS,
  A_EXPLORATORY_QUESTIONS,
  A_REPORTING_SHAPE,
  A_VERIFICATION_REPORT,
  A_COMPLETION_CODE_CHANGE,
  A_COMPLETION_READ_ONLY,
]

/** The full migrated body atom graph (after-persona ∪ after-pack). */
export const BODY_ATOMS: readonly InstructionAtom[] = [
  ...BODY_AFTER_PERSONA_ATOMS,
  ...BODY_AFTER_PROMPT_PACK_ATOMS,
]
