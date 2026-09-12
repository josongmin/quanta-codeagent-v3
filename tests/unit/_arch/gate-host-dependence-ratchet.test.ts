/**
 * RATCHET — every gate that can PASS by finding nothing on this host is MARKED.
 *
 * `hostDependent` exists so a green that includes a gate which verified nothing does
 * not poison the numbers beside it. It shipped set on ZERO of 20 gates: the field was
 * declared, documented at length, and rendered in two places in `gate.ts`, and the one
 * gate written for it said so in its own `why` ("LOCALLY THIS PASSES BY SKIPPING")
 * while leaving the field undefined. Nothing noticed, because nothing asserted it.
 *
 * This file is what makes "set on nothing" unable to come back. It pins the marked SET
 * by id, not a count, so removing a mark fails by name and adding one requires a
 * deliberate edit here.
 *
 * The three marked gates and why, each measured on this host:
 *
 *  - `contract` — `bun run test:contract` is 8 pass / 5 skip with pyright, tsserver and
 *    python3 all PRESENT and docker up; every skip is "no capability receipt:
 *    QUANTA_CAPABILITY_RECEIPT is unset".
 *  - `real-toolchain-e2e` — every case needs a real external toolchain and skips when
 *    its tool is absent.
 *  - `full-suite` — `declared-pending-gate` capability members are NOT lane-gated, so
 *    they classify as ordinary and land in this gate's tiers;
 *    `os-sandbox-bwrap-real-exec-e2e` is `["prepush","pr","full","nightly"]` and runs
 *    3 pass / 2 skip here.
 */
import { describe, expect, test } from "bun:test"
import { GATE_CONTRACT, GATES } from "../../../tools/dev/gate-manifest"

/** The marked set. Changing this is the deliberate act; drifting from it is not. */
const HOST_DEPENDENT_GATES: readonly string[] = ["contract", "full-suite", "real-toolchain-e2e"]

describe("gate host-dependence ratchet", () => {
  test("ANTI-VACUITY: the definitions are populated and the ids resolve", () => {
    expect(GATES.length).toBeGreaterThan(15)
    // `GATE_CONTRACT` is the id+stage contract; `GATES` carries the definitions and is
    // where `hostDependent` lives. My first version read the contract and saw an empty
    // marked set while the manifest had three marks — the two arrays are not the same
    // shape, and reading the wrong one is how a ratchet asserts nothing.
    expect(GATE_CONTRACT.length).toBe(GATES.length)
    const ids = new Set(GATES.map((g) => g.id))
    for (const id of HOST_DEPENDENT_GATES) {
      expect(ids.has(id), `${id} is not a gate id — re-anchor this ratchet`).toBe(true)
    }
  })

  test("exactly the declared gates are marked hostDependent", () => {
    const marked = GATES.filter((g) => g.hostDependent !== undefined)
      .map((g) => g.id)
      .sort()
    expect(
      marked,
      "a gate that can pass by finding nothing here must be marked, and a mark must not " +
        "be removed without removing it from this ratchet too",
    ).toEqual([...HOST_DEPENDENT_GATES].sort())
  })

  /** A mark with no reason is the field set to satisfy this file. */
  test("every mark carries a real reason", () => {
    for (const g of GATES) {
      if (g.hostDependent === undefined) continue
      expect(g.hostDependent.trim().length, `${g.id}'s reason is too thin`).toBeGreaterThanOrEqual(
        60,
      )
    }
  })

  /**
   * The reason must describe the MECHANISM, not a count.
   *
   * `real-toolchain-e2e`'s first reason said "11 of the 35 capability-group member
   * files cannot execute" — arithmetically true of the REPO and wrong for that gate,
   * which runs 17 files, 5 of the 11 living in a directory it never reaches. A number
   * in a prose field drifts the moment the corpus or the host moves.
   */
  test("no mark states a bare file count", () => {
    for (const g of GATES) {
      if (g.hostDependent === undefined) continue
      const bare = /\b\d+ of (the )?\d+\b/.exec(g.hostDependent)
      // A count is allowed only where the sentence also says it is NOT the claim.
      if (bare !== null) {
        expect(
          /drifts|not a count|wrong for this gate|MECHANISM/i.test(g.hostDependent),
          `${g.id} states "${bare[0]}" without saying why a count is not the claim`,
        ).toBe(true)
      }
    }
  })
})
