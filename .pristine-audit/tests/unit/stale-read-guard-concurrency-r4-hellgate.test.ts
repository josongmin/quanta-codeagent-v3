/**
 * ROUND-4 concurrency hellgate — stale-read-guard state maps.
 *
 * `ReadFileState` is PURE in-memory: `record`, `recordReadRange`, `checkFresh`,
 * `recordedRangeHash` contain NO awaits, so two of them can never interleave
 * MID-METHOD on one JS thread. The only race is at the CALLER: two concurrent
 * `read`s each `await` the read pipeline (which can hash DIFFERENT content when
 * a write lands between), then each `record(...)` / `recordReadRange(...)`. The
 * map is last-writer-wins per key.
 *
 * The invariant we PROVE (clean-with-proof): a lost-update on the freshness /
 * dedup map can only cause a CONSERVATIVE outcome —
 *   (a) the dedup short-circuit NEVER fires on content that differs from what
 *       the model last saw for the range (content-truth, UUX-6-07: the decision
 *       compares the hash of the JUST-READ content against the recorded hash,
 *       so a stale recorded value yields a MISS, never a false hit — and a HIT
 *       is truthful by construction: equal hashes ⇔ the model already holds
 *       these exact bytes), and
 *   (b) `guardWrite` NEVER admits a write whose target advanced past ANY
 *       recorded read-baseline (a stale-low baseline only makes the gate MORE
 *       conservative, never less).
 *
 * We drive the exact caller interleaving with two recorders whose reads
 * resolved to different content hashes, in both completion orders.
 */

import { describe, expect, test } from "bun:test"
import { guardWrite, ReadFileState } from "@/tool/stale-read-guard"

const PATH = "/repo/src/a.ts"

/** The dedup decision the read tool makes: it re-reads + hashes the CURRENT
 *  content and compares against the recorded range hash. A hit requires strict
 *  equality. */
const dedupHit = (state: ReadFileState, offset: number, limit: number, currentHash: string) => {
  const recorded = state.recordedRangeHash(PATH, offset, limit)
  return recorded !== undefined && recorded === currentHash
}

describe("ROUND-4 stale-read-guard — interleaved record vs differing content", () => {
  test("lost-update on the range map never yields a FALSE dedup hit on changed content", async () => {
    // readA hashed content "hA"; readB hashed content "hB" (a write landed
    // between). Drive BOTH completion orders; in each, the recorded value is one
    // of the two observed hashes. A subsequent read whose CURRENT content hash
    // differs from the recorded value must MISS (render full), never
    // short-circuit.
    for (const order of [
      ["hA", "hB"],
      ["hB", "hA"],
    ] as const) {
      const state = new ReadFileState()
      // simulate the two interleaved recorders (the later call wins the key)
      state.recordReadRange(PATH, 1, 2000, order[0])
      state.recordReadRange(PATH, 1, 2000, order[1])
      const winner = order[1] // last writer wins

      // A future read whose TRUE current content hashes to "hB": it must
      // dedup-hit ONLY when the recorded value equals "hB" — i.e. only when the
      // model already holds exactly the current bytes.
      const wouldHitAtB = dedupHit(state, 1, 2000, "hB")
      expect(wouldHitAtB).toBe(winner === "hB")

      // The critical safety property: there is NO current content at which the
      // dedup fires while the bytes differ from the recorded snapshot. The hit
      // predicate is `recorded === current`, so a hit ⇒ equal hashes ⇒ same
      // content. Prove it across a spread of current hashes.
      for (const cur of ["h0", "hA", "h1", "hB", "h2"]) {
        if (dedupHit(state, 1, 2000, cur)) expect(cur).toBe(winner)
      }
    }
  })

  test("a stale-low freshness baseline only makes guardWrite MORE conservative", async () => {
    // Two concurrent reads record the freshness baseline; the lost-update can
    // leave EITHER mtime as the baseline. In every case, a write whose target
    // mtime advanced past the baseline must be BLOCKED (never silently admitted).
    for (const baseline of [100, 200]) {
      const state = new ReadFileState()
      state.record(PATH, baseline)

      // Disk advanced to 300 (an external write after both reads) → must block.
      const blocked = guardWrite(state, PATH, 300)
      expect(blocked.ok).toBe(false)

      // Disk == baseline → fresh, admitted.
      const same = guardWrite(state, PATH, baseline)
      expect(same.ok).toBe(true)

      // A stale-LOW baseline (100) is strictly more conservative than a higher
      // one (200): for a disk mtime of 150, baseline-100 BLOCKS, baseline-200
      // admits. Neither admits a write on content that advanced past its OWN
      // recorded baseline — the safety contract.
      const at150 = guardWrite(state, PATH, 150)
      expect(at150.ok).toBe(baseline >= 150)
    }
  })

  test("different ranges never collide — interleaved records stay independent", async () => {
    const state = new ReadFileState()
    // Two reads of DIFFERENT windows of the same file, interleaved.
    state.recordReadRange(PATH, 1, 100, "h100")
    state.recordReadRange(PATH, 101, 100, "h200")
    // Each range retains its own hash — no cross-contamination from interleave.
    expect(state.recordedRangeHash(PATH, 1, 100)).toBe("h100")
    expect(state.recordedRangeHash(PATH, 101, 100)).toBe("h200")
    // A read of a THIRD, never-recorded window misses cleanly.
    expect(state.recordedRangeHash(PATH, 201, 100)).toBeUndefined()
  })
})
