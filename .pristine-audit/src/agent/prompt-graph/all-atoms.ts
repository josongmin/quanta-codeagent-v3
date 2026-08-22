/**
 * ADR-0538 Phase 3 — the FULL instruction-atom graph.
 *
 * The union of every migrated atom set across all channels:
 *   - TOOL_USE_ATOMS  (Phase 1) — posture base ∪ verify axis (`system.base`).
 *   - BODY_ATOMS      (Phase 2) — the flat static body (`system.base`).
 *   - NOTICE_ATOMS    (Phase 2) — mode / brief notices (`message.system_reminder`).
 *   - DYNAMIC_ATOMS   (Phase 3) — the per-turn reminder content (`message.system_reminder`).
 *
 * `verifyRuleGraph(ALL_ATOMS, reachableAllContexts())` is the whole-graph
 * soundness gate (conflict / supersede / coverage / hidden-assumption /
 * cached-section-budget / static-dynamic / authority / manifest-completeness /
 * dynamic-content-placement). Snapshot-parity runs when a compile manifest is
 * additionally supplied.
 *
 * NOTE: TOOL_USE_ATOMS + BODY_ATOMS BOTH ride `system.base`; the posture-base
 * `honesty`/`env` sections and the body sections are DISJOINT by `section`
 * label, so they order deterministically without collision. They are unioned
 * here purely for the whole-graph completeness checks (duplicate-id /
 * placement / dynamic-content) — the RENDER path still selects each group at
 * its own slot in `buildSystemPrompt`.
 */

import { TOOL_USE_ATOMS } from "./atoms"
import { BODY_ATOMS } from "./atoms-body"
import { DYNAMIC_ATOMS } from "./atoms-dynamic"
import { NOTICE_ATOMS } from "./atoms-notices"
import type { InstructionAtom } from "./types"

export const ALL_ATOMS: readonly InstructionAtom[] = [
  ...TOOL_USE_ATOMS,
  ...BODY_ATOMS,
  ...NOTICE_ATOMS,
  ...DYNAMIC_ATOMS,
]
