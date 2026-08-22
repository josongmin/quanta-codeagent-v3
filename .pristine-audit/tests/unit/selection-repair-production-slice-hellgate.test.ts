/**
 * HELLGATE — jun-23 W2-2: the SELECTOR repair packet must carry a REAL owner
 * source slice ON THE PRODUCTION PATH (through `runSelection` →
 * `maybeAppendSelectorRepair` → `buildRepairPacketText`), not just when the
 * builder is called directly.
 *
 * Wave-1 made `buildRepairPacketText` ACCEPT `readSource`/`issueSymbols` (and the
 * builder-level test `selection-repair-slice-surface.test.ts` proves the slice
 * resolves there). But the caller `maybeAppendSelectorRepair` did NOT pass them,
 * and `runSelection`'s arg type carried neither — so in production the SELECTOR
 * repair owner evidence stayed PATH-ONLY (`symbols:[]`, no slice), which forces
 * the adaptive router's `localizationCertain=false` in every selector-repair
 * phase (A2 over-routing). W2-2 threads `repairReadSource` + `repairIssueSymbols`
 * through `runSelection` and into the packet builder.
 *
 * Teeth:
 *  (1) ENGAGE: drive `runSelection` (clean, oracle-failure repair) with a real
 *      `repairReadSource` + `repairIssueSymbols`; the repair prompt the
 *      production `generate` port receives (and the recorded packet) CONTAINS
 *      the resolved owner source slice — the bytes a model actually sees.
 *  (2) TRUE-POSITIVE: the recorded selector-repair packet projects to router
 *      evidence with `localizationCertain:true` (the candidate touched the owner
 *      file AND its slice resolved).
 *  (3) RED-WITHOUT-FIX / still-false-when-unresolvable: the SAME production drive
 *      with NO `repairReadSource` (the pre-fix wiring) yields a path-only packet
 *      with no slice and `localizationCertain:false` — proving the slice only
 *      reaches the packet because the driver now threads the reader.
 *
 * Blindness: `repairReadSource` reads PUBLIC owner source (the same source the
 * generation stage reads); `repairIssueSymbols` are PUBLIC issue symbols — never
 * a hidden-test path/command.
 */

import { describe, expect, it } from "bun:test"
import { projectRouterEvidence } from "@/runner/batch/eval/adaptive-escalation/router-evidence"
import type { LlmEvidencePacket } from "@/runner/batch/eval/llm-evidence-packet"
import {
  type Candidate,
  runSelection,
  type SelectionPorts,
} from "@/runner/batch/eval/selection-executor"

const OWNER_FILE = "pkg/axis.py"
const ISSUE_SYMBOL = "invert_axis"
const OWNER_SOURCE = [
  "import os",
  "",
  "class Axis:",
  `    def ${ISSUE_SYMBOL}(self, ax):`,
  "        ax.set_xlim(1, 0)",
  "        return ax",
  "",
].join("\n")

// A candidate that TOUCHES the owner file (so its edit surface includes it →
// router localizationCertain can be a true-positive when the slice resolves).
const candPatch = [
  `diff --git a/${OWNER_FILE} b/${OWNER_FILE}`,
  `--- a/${OWNER_FILE}`,
  `+++ b/${OWNER_FILE}`,
  `@@ -4,2 +4,2 @@ def ${ISSUE_SYMBOL}(self, ax):`,
  "-        ax.set_xlim(1, 0)",
  "+        ax.set_xlim(0, 1)",
].join("\n")

const candidate = (): Candidate => ({
  id: "cand-0",
  patch: candPatch,
  turns: 1,
  files: [OWNER_FILE],
  baseValidatedRed: true,
  familyOwnerFiles: [OWNER_FILE],
})

/** Drive the production selector-repair path. Returns the repair prompt handed
 *  to the generate port (the bytes a model receives) + every recorded packet. */
const driveSelectorRepair = async (opts: {
  readonly withReader: boolean
}): Promise<{ repairPrompt: string | undefined; packets: LlmEvidencePacket[] }> => {
  const packets: LlmEvidencePacket[] = []
  const seeds: (string | undefined)[] = []
  const generate: SelectionPorts["generate"] = async (_i, seed) => {
    seeds.push(seed)
    // The repaired candidate also touches the owner file (a real regenerate).
    return candidate()
  }
  await runSelection({
    n: 1,
    mode: "clean",
    seeds: [undefined],
    owners: new Set([OWNER_FILE]),
    problemStatement: "Axis inversion drops explicit limits.",
    // Oracle-failure repair trigger: a validated-repro seed + unresolved consensus.
    oracleFailureRepairSeed: "VALIDATED-REPRO: assert axis limits preserved.",
    ...(opts.withReader
      ? {
          repairReadSource: (rel: string) => (rel === OWNER_FILE ? OWNER_SOURCE : null),
          repairIssueSymbols: [ISSUE_SYMBOL],
        }
      : {}),
    recordLlmEvidencePacket: (p) => packets.push(p),
    ports: {
      generate,
      // Unresolved repro consensus (votes < k) ⇒ reproOracleRepairRequired fires.
      resolvedKofN: async () => ({ votes: 0, k: 1 }),
    },
  })
  // The repair prompt is the seed handed to the SECOND generate call (the first
  // is the initial generation with `undefined`).
  return { repairPrompt: seeds[1], packets }
}

describe("jun-23 W2-2 — selector repair slice reaches the PRODUCTION packet (hellgate)", () => {
  it("ENGAGE — the resolved owner slice appears in the repair prompt the generate port receives", async () => {
    const { repairPrompt, packets } = await driveSelectorRepair({ withReader: true })

    // The repair was actually appended (production path engaged the builder).
    expect(repairPrompt).toBeDefined()
    // ENGAGE: the slice bytes a model receives carry the real owner source.
    expect(repairPrompt).toContain(`def ${ISSUE_SYMBOL}`)
    expect(repairPrompt).not.toContain("import os") // slice, not whole file

    const owner = packets.flatMap((p) => p.ownerEvidence).find((o) => o.file === OWNER_FILE)
    expect(owner?.sourceSlice).toBeDefined()
    expect(owner?.sourceSlice).toContain(`def ${ISSUE_SYMBOL}`)
  })

  it("TRUE-POSITIVE — the recorded selector-repair packet projects localizationCertain:true", async () => {
    const { packets } = await driveSelectorRepair({ withReader: true })
    // At least one recorded packet (repair_seed / post_review) must let the router
    // see a confident fix site: a resolved owner slice for a TOUCHED owner file.
    const certain = packets.some((p) => projectRouterEvidence(p).facts.localizationCertain === true)
    expect(certain).toBe(true)
  })

  it("RED-WITHOUT-FIX — no reader (pre-fix wiring) ⇒ path-only, localizationCertain:false", async () => {
    const { repairPrompt, packets } = await driveSelectorRepair({ withReader: false })
    // Repair still happens, but path-only: no slice in the model-visible bytes.
    expect(repairPrompt).toBeDefined()
    expect(repairPrompt).not.toContain(`def ${ISSUE_SYMBOL}`)

    const owner = packets.flatMap((p) => p.ownerEvidence).find((o) => o.file === OWNER_FILE)
    expect(owner?.sourceSlice).toBeUndefined()
    // Genuinely unresolvable ⇒ router stays at deeper_localize (NOT a false true).
    const anyCertain = packets.some(
      (p) => projectRouterEvidence(p).facts.localizationCertain === true,
    )
    expect(anyCertain).toBe(false)
  })
})
