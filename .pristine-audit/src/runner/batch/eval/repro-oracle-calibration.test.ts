/**
 * D1 hellgate — repro-oracle base-vacuity probes the sandbox AS-DELIVERED,
 * and calibration leaves it at base (clean).
 *
 * NON-INERT design (no unconditional reset): the injected `resolvedProbe` is a
 * REAL base-vacuity detector — it reports "resolved" iff `git status --porcelain`
 * is empty (a clean == base tree). We git-init a temp sandbox and leave an
 * UNCOMMITTED edit (a dirty, NON-base tree). Two invariants are pinned:
 *
 *   (1) The base-vacuity probe (`baseVerdict`) runs on the sandbox EXACTLY as it
 *       arrives — a dirty tree is visible to it, so `baseResolved`/`vacuous` do
 *       NOT false-green on a non-base tree. If `calibrateReproOracle` were to
 *       silently reset the tree before probing base, the probe would see a clean
 *       tree and false-green (baseResolved=true) — this test would go RED.
 *
 *   (2) After `calibrateReproOracle` returns, the sandbox is CLEAN (at base):
 *       the gold materialize→probe→reset cycle (`withCandidatePatch`) restores
 *       base regardless of the dirty pre-state, and gold itself calibrates
 *       (goldCalibrated=true) because it applies onto the reset base and the
 *       resulting tree is clean.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { calibrateReproOracle } from "./repro-oracle-calibration"

const TIMEOUT_MS = 30_000
const G = "git -c user.email=b@b -c user.name=b -c commit.gpgsign=false"

const sh = async (cmd: string, cwd: string): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  return { code, out }
}

const porcelain = async (cwd: string): Promise<string> =>
  (await sh(`${G} status --porcelain`, cwd)).out.trim()

/** REAL fix-detecting probe: reports "resolved" iff the committed file holds the
 *  FIXED content (`x = 1`) — the gold state. On the BASE (buggy `x = 0`) tree it
 *  reports not-resolved (votes<k), so the metamorphic base-vacuity check reads
 *  the un-patched tree as RED (not vacuous). Each call ALSO records the tree's
 *  `git status --porcelain` so the test can prove the base probe ran on the
 *  sandbox AS-DELIVERED (dirty), not on a silently-reset tree. This is exactly
 *  the {votes,k}|null shape a patched-resolved consensus produces, injected so
 *  the calibration composes without importing the production probe. */
const makeFixDetectingProbe =
  (porcelainAtCall: string[]) =>
  async (sandbox: string): Promise<{ votes: number; k: number } | null> => {
    porcelainAtCall.push(await porcelain(sandbox))
    const content = (await sh("cat mod.py", sandbox)).out
    return content.includes("x = 1") ? { votes: 1, k: 1 } : { votes: 0, k: 1 }
  }

describe("D1 — calibrateReproOracle base-vacuity on a dirty (non-base) sandbox", () => {
  let dir: string
  let baseCommit: string
  let goldPatch: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "quanta-repro-calib-"))
    if ((await sh(`${G} init -q -b main`, dir)).code !== 0) throw new Error("git init failed")
    // Committed file — the gold patch will modify it.
    writeFileSync(join(dir, "mod.py"), "x = 0\n")
    if ((await sh(`${G} add -A && ${G} commit -q -m init`, dir)).code !== 0) {
      throw new Error("git commit failed")
    }
    baseCommit = (await sh(`${G} rev-parse HEAD`, dir)).out.trim()
    // Gold patch: a valid unified diff modifying the committed file.
    goldPatch = [
      "diff --git a/mod.py b/mod.py",
      "index 0000000..1111111 100644",
      "--- a/mod.py",
      "+++ b/mod.py",
      "@@ -1 +1 @@",
      "-x = 0",
      "+x = 1",
      "",
    ].join("\n")
    // Leave the sandbox DIRTY (uncommitted, untracked file) — a NON-base tree.
    writeFileSync(join(dir, "uncommitted.txt"), "dirty\n")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("dirty tree fails base-vacuity (baseResolved=false) — probe saw the dirt", async () => {
    // Precondition: the sandbox really is dirty before calibration.
    expect(await porcelain(dir)).not.toBe("")

    const calls: string[] = []
    const result = await calibrateReproOracle({
      resolvedProbe: makeFixDetectingProbe(calls),
      goldPatch,
      sandbox: dir,
      baseCommit,
      timeoutMs: TIMEOUT_MS,
    })

    // (1) The FIRST probe call is the base-vacuity probe. It ran on the tree
    // AS-DELIVERED (dirty) — proving calibration did NOT silently reset before
    // probing base. A dirty tree is NOT vacuous-green.
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]).not.toBe("") // base probe observed the uncommitted file
    expect(result.baseResolved).toBe(false)
    expect(result.vacuous).toBe(false)

    // Gold applies onto the reset base ⇒ the oracle vouches for the known-correct
    // fix on a clean tree ⇒ calibrated, not a false-negative.
    expect(result.available).toBe(true)
    expect(result.goldCalibrated).toBe(true)
    expect(result.falseNegative).toBe(false)
  })

  test("after calibration the sandbox is CLEAN (restored to base)", async () => {
    const calls: string[] = []
    await calibrateReproOracle({
      resolvedProbe: makeFixDetectingProbe(calls),
      goldPatch,
      sandbox: dir,
      baseCommit,
      timeoutMs: TIMEOUT_MS,
    })
    // withCandidatePatch's trailing reset (checkout -f && reset --hard &&
    // clean -fdx) restores base regardless of the dirty pre-state.
    expect(await porcelain(dir)).toBe("")
  })
})
