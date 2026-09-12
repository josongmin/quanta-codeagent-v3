/**
 * The compiled binary's version line carries the source it was built from.
 *
 * WHY. `~/.local/bin/quanta` is a compiled single-file binary and nothing in it
 * recorded WHICH commit produced it. `--version` reports `package.json.version`,
 * which only moves when the install script bumps it, so a binary hundreds of
 * commits stale printed the same string as a fresh one — the repo's README already
 * names this the number-one cause of "I fixed it and the CLI did not change".
 *
 * WHAT IS ASSERTED HERE, AND WHAT IS NOT. These are pure unit assertions over
 * `renderVersion`'s resolution order and the label shape. They cannot prove the
 * bake itself: that needs a real `bun build --compile` and a run from OUTSIDE the
 * repo, because `resolveVersion` walks up for a `package.json` and inside the repo
 * that walk succeeds and masks a missing stamp — the same trap
 * `compiled-binary-asset-parity` records for wasm assets. Measured manually at the
 * landing commit, from `/tmp`, with both vars unset:
 *
 *     quanta 1.0.035 (6a82f65d1c9d-dirty)
 *
 * and from source, unstamped and unchanged:
 *
 *     quanta 1.0.035
 *
 * Recorded rather than automated: a test that shells out to a 75 MB compile is not
 * something a unit lane should own, and claiming the bake works from inside the
 * repo would be the exact false green this file warns about.
 */
import { describe, expect, test } from "bun:test"
import { composeCommitLabel } from "../../../src/apps/cli/build-stamp"
import { renderVersion } from "../../../src/apps/cli/version-cmd"

const line = (env: Record<string, string | undefined>, bakedCommit?: string): string =>
  renderVersion({
    env: env as NodeJS.ProcessEnv,
    version: "9.9.9",
    cwd: "/tmp",
    ...(bakedCommit === undefined ? {} : { bakedCommit }),
  }).split("\n")[0] ?? ""

describe("build stamp → version line", () => {
  test("unstamped ⇒ bare version, byte-identical to the pre-stamp output", () => {
    expect(line({})).toBe("quanta 9.9.9")
  })

  test("an explicit QUANTA_COMMIT still wins (tests seed it; operators override)", () => {
    expect(line({ QUANTA_COMMIT: "deadbeefcafe" })).toBe("quanta 9.9.9 (deadbeefcafe)")
  })

  test("a long explicit commit is truncated, not printed whole", () => {
    expect(line({ QUANTA_COMMIT: "0123456789abcdef0123" })).toBe("quanta 9.9.9 (0123456789ab)")
  })

  test("an empty QUANTA_COMMIT is treated as absent, not as a blank commit", () => {
    expect(line({ QUANTA_COMMIT: "   " })).toBe("quanta 9.9.9")
  })

  // THE BRANCH THAT MATTERS, and it was unreachable until the baked label became a
  // parameter. `build-stamp` reads `process.env` at module load, so from source it
  // is always undefined — deleting the whole fallback left this suite GREEN, which
  // is how a stamp feature ships doing nothing.
  test("a baked stamp renders when no explicit commit is set", () => {
    expect(line({}, "6a82f65d1c9d")).toBe("quanta 9.9.9 (6a82f65d1c9d)")
  })

  test("the dirty marker survives into the line", () => {
    expect(line({}, "6a82f65d1c9d-dirty")).toBe("quanta 9.9.9 (6a82f65d1c9d-dirty)")
  })

  test("an explicit commit still beats a baked one", () => {
    expect(line({ QUANTA_COMMIT: "deadbeefcafe" }, "6a82f65d1c9d")).toBe(
      "quanta 9.9.9 (deadbeefcafe)",
    )
  })

  test("an empty baked stamp is absent, not a blank commit", () => {
    expect(line({}, "")).toBe("quanta 9.9.9")
  })
})

/**
 * The dirty marker, asserted through the same pure helper the renderer uses.
 *
 * A stamp that omitted it would let a build from a modified tree claim a clean
 * commit's identity, which is worse than no stamp: it is a provenance claim that
 * is wrong in the direction of looking trustworthy.
 */
describe("build stamp label shape", () => {
  test("the label module reports absent when the build vars are unset", async () => {
    // Re-imported in isolation: the module reads `process.env` at load, and this
    // suite must not depend on whichever value a sibling test left behind.
    const mod = await import(`../../../src/apps/cli/build-stamp?unstamped=${Date.now()}`)
    if (process.env.QUANTA_BUILD_COMMIT === undefined) {
      expect(mod.buildCommitLabel()).toBeUndefined()
      expect(mod.BUILD_DIRTY).toBe(false)
    } else {
      // A stamped runner (a compiled binary executing this suite) is a legitimate
      // state — assert the shape instead of pretending the env is empty.
      expect(mod.buildCommitLabel()).toContain(process.env.QUANTA_BUILD_COMMIT)
    }
  })
})

/**
 * The dirty branch, exercised for real.
 *
 * `BUILD_DIRTY` is read from `process.env` at module load, so a source-run test can
 * never populate it — measured: deleting the `-dirty` branch entirely left every
 * assertion in this file green. The composition is therefore a pure function of its
 * inputs, and this is what pins it.
 */
describe("composeCommitLabel — the dirty marker is load-bearing", () => {
  test("a clean build is the bare commit", () => {
    expect(composeCommitLabel("6a82f65d1c9d", false)).toBe("6a82f65d1c9d")
  })

  test("a dirty build says so — a dirty tree must not borrow a clean identity", () => {
    expect(composeCommitLabel("6a82f65d1c9d", true)).toBe("6a82f65d1c9d-dirty")
  })

  test("no commit ⇒ no label, dirty or not", () => {
    expect(composeCommitLabel(undefined, true)).toBeUndefined()
    expect(composeCommitLabel("", true)).toBeUndefined()
  })
})
