/**
 * DRIFT GUARD — the gate manifest must match its exact (id, stage) contract, and
 * BOTH the listing path and the run path must check it.
 *
 * # The regression this is built from (measured, not hypothetical)
 *
 * `gate.ts` guarded the manifest with a hand-written count floor,
 * `MIN_OWNED = { precommit: 10, prepush: 11 }`. Commit `a6703e00d` consolidated
 * three precommit gates — `fc-validate`, `fc-diff`, `fc-lint` — into one,
 * `fc-ci`. Legitimate edit; the floor was not touched. From that commit the
 * manifest owned 8 precommit gates against a floor of 10, so at HEAD
 * `85a99bb6f`:
 *
 *     $ bun tools/dev/gate.ts precommit
 *     gate.ts: the manifest owns 8 precommit gate(s), below the floor of 10. …
 *     $ echo $?
 *     1
 *
 * — before dispatching a single gate. `bun run precommit`, `bun run prepush`,
 * and every `gate.ts <tier>` were dead, and the message blamed the manifest for
 * a stale constant. Meanwhile `--list` returned BEFORE the check and kept
 * printing a healthy manifest, so the listing path and the run path disagreed
 * about the same file.
 *
 * # What this test pins
 *
 * 1. The current manifest satisfies the contract exactly (with an anti-vacuity
 *    floor, so an emptied manifest or an emptied contract is RED, not trivially
 *    clear).
 * 2. Each violation class names the offending gate ID — the thing a count
 *    cannot do. In particular the historical 3-out/1-in consolidation is RED as
 *    three `missing` plus one `unexpected`, where a count floor of 8 clears.
 * 3. `gate.ts` runs the shared validator BEFORE the `--list` branch, so the two
 *    paths cannot diverge again.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { GATE_CONTRACT, GATES } from "../../../tools/dev/gate-manifest"
import {
  formatGateManifestViolations,
  type GateContractEntry,
  type GateUnderContract,
  validateGateManifest,
} from "../../../tools/dev/gate-manifest-contract"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** The manifest reduced to the shape the validator compares. */
const manifest = (): GateUnderContract[] =>
  GATES.map((gate) =>
    gate.consumes === undefined
      ? { id: gate.id, stage: gate.stage }
      : { id: gate.id, stage: gate.stage, consumes: gate.consumes },
  )

const contract = (): GateContractEntry[] => GATE_CONTRACT.map((entry) => ({ ...entry }))

const kinds = (violations: readonly { readonly kind: string }[]): readonly string[] =>
  [...new Set(violations.map((v) => v.kind))].sort()

const idsOfKind = (
  violations: readonly { readonly kind: string; readonly id: string }[],
  kind: string,
): readonly string[] =>
  violations
    .filter((v) => v.kind === kind)
    .map((v) => v.id)
    .sort()

describe("gate manifest contract", () => {
  test("the manifest at HEAD matches its contract exactly", () => {
    const violations = validateGateManifest(manifest(), contract())
    expect(formatGateManifestViolations(violations)).toBe("")

    // ANTI-VACUITY. Every assertion above is satisfied by two empty lists, which
    // is exactly the hole a count floor leaves when someone edits the number
    // instead of the manifest. Both sides must be populated, in both stages.
    expect(GATE_CONTRACT.length).toBe(GATES.length)
    expect(GATE_CONTRACT.length).toBeGreaterThanOrEqual(16)
    expect(GATE_CONTRACT.filter((e) => e.stage === "precommit").length).toBeGreaterThanOrEqual(6)
    expect(GATE_CONTRACT.filter((e) => e.stage === "prepush").length).toBeGreaterThanOrEqual(8)
  })

  test("a deleted gate is RED by ID, not by count", () => {
    const broken = manifest().filter((gate) => gate.id !== "lint-debt")
    const violations = validateGateManifest(broken, contract())
    expect(idsOfKind(violations, "missing")).toEqual(["lint-debt"])
    expect(formatGateManifestViolations(violations)).toContain('gate "lint-debt"')
  })

  test("an unlisted new gate is RED by ID", () => {
    const broken: GateUnderContract[] = [...manifest(), { id: "smuggled-gate", stage: "precommit" }]
    const violations = validateGateManifest(broken, contract())
    expect(idsOfKind(violations, "unexpected")).toEqual(["smuggled-gate"])
  })

  test("a mis-staged gate is RED even though the total is unchanged", () => {
    // The defect a count floor structurally cannot see: totals hold, ownership
    // moved. `lint` running in the suite stage instead of the static stage means
    // precommit stops checking it while every number still adds up.
    const broken = manifest().map((gate) =>
      gate.id === "lint" ? { ...gate, stage: "prepush" as const } : gate,
    )
    const violations = validateGateManifest(broken, contract())
    expect(idsOfKind(violations, "mis-staged")).toEqual(["lint"])
    expect(broken.length).toBe(manifest().length)
  })

  test("the historical 3-into-1 consolidation is RED by ID where a count floor clears", () => {
    // Replay of commit a6703e00d against the OLD contract: `fc-validate`,
    // `fc-diff` and `fc-lint` leave, `fc-ci` arrives. Net count change is -2, so
    // a floor of 8 (or any floor at or below the new count) reports nothing —
    // the exact set reports all four names.
    const oldContract: GateContractEntry[] = [
      ...contract().filter((entry) => entry.id !== "fc-ci"),
      { id: "fc-validate", stage: "precommit" },
      { id: "fc-diff", stage: "precommit" },
      { id: "fc-lint", stage: "precommit" },
    ]
    const violations = validateGateManifest(manifest(), oldContract)
    expect(idsOfKind(violations, "missing")).toEqual(["fc-diff", "fc-lint", "fc-validate"])
    expect(idsOfKind(violations, "unexpected")).toEqual(["fc-ci"])

    // The count floor that shipped would have been satisfied by this manifest.
    const precommitCount = manifest().filter((g) => g.stage === "precommit").length
    expect(precommitCount).toBe(8)
  })

  test("a duplicated gate id is RED", () => {
    const first = manifest()[0]
    if (first === undefined) throw new Error("manifest is empty")
    const violations = validateGateManifest([...manifest(), { ...first }], contract())
    expect(idsOfKind(violations, "duplicate")).toEqual([first.id])
  })

  test("a consumes that names no gate is RED", () => {
    const broken = manifest().map((gate) =>
      gate.id === "scan-reach" ? { ...gate, consumes: "Full-Suite" } : gate,
    )
    const violations = validateGateManifest(broken, contract())
    expect(idsOfKind(violations, "dangling-consumes")).toEqual(["scan-reach"])
  })

  test("a consumes cycle is RED and names every member", () => {
    const broken = manifest().map((gate) => {
      if (gate.id === "full-suite") return { ...gate, consumes: "scan-reach" }
      return gate
    })
    const violations = validateGateManifest(broken, contract())
    expect(idsOfKind(violations, "consumes-cycle")).toEqual(["full-suite", "scan-reach"])
  })

  test("mass mis-staging that empties a stage is RED", () => {
    const broken = manifest().map((gate) => ({ ...gate, stage: "prepush" as const }))
    const violations = validateGateManifest(broken, contract())
    expect(kinds(violations)).toContain("empty-stage")
    expect(idsOfKind(violations, "empty-stage")).toEqual(["precommit"])
  })

  test("an emptied contract is RED rather than vacuously satisfied", () => {
    const violations = validateGateManifest(manifest(), [])
    expect(idsOfKind(violations, "empty-contract")).toEqual(["<contract>"])
  })

  test("an emptied manifest is RED, naming every contracted gate", () => {
    const violations = validateGateManifest([], contract())
    expect(idsOfKind(violations, "missing")).toEqual([...GATE_CONTRACT.map((e) => e.id)].sort())
  })

  test("gate.ts validates the contract BEFORE the --list branch", () => {
    // Structural, because the defect was ORDER: the listing path returned first
    // and never validated. A test that only calls the validator would pass while
    // `--list` still bypassed it.
    const source = readFileSync(join(REPO_ROOT, "tools", "dev", "gate.ts"), "utf8")
    const validateAt = source.indexOf("validateGateManifest(GATES, GATE_CONTRACT)")
    const listBranchAt = source.indexOf('if (wants("--list")) {')

    // ANTI-VACUITY: a rename of either marker must fail loudly here rather than
    // make the ordering assertion compare -1 against -1.
    expect(validateAt).toBeGreaterThan(-1)
    expect(listBranchAt).toBeGreaterThan(-1)
    expect(validateAt).toBeLessThan(listBranchAt)

    // The stale count floor must not come back in any form.
    expect(source).not.toContain("MIN_OWNED")
  })
})
