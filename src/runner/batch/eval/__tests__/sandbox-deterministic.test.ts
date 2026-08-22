/**
 * B1 gate fix (jun-27-bench-spot-resume-s3.md): make the bench sandbox workdir
 * DETERMINISTIC when (and ONLY when) `QUANTA_BENCH_RESUME` is ON, so a partial
 * cassette recorded on box A replays HIT on box B (the absolute workdir is no
 * longer a per-box random `mkdtemp` suffix embedded in the prompt).
 *
 * Default OFF must stay byte-identical to today: two random `mkdtemp` levels →
 * two DIFFERENT paths per call. The companion gate proof lives in
 * `tests/integration/bench-resume-determinism.test.ts` (content-hash MISS/HIT).
 *
 * The test overrides `benchWorkRoot()` to a temp dir via `QUANTA_BENCH_HOME`
 * (its documented operator override) + `__resetRuntimeConfig()`, so nothing
 * pollutes the real persistent bench root.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { benchInstanceWorkSlug, benchWorkRoot } from "../../corpus/paths"
import type { Instance } from "../../types"
import { cleanupSandbox, copyRepo, createSandbox } from "../sandbox"

let TMP_HOME: string
const ORIG_HOME = process.env.QUANTA_BENCH_HOME
const ORIG_RESUME = process.env.QUANTA_BENCH_RESUME

const setResume = (v: string | undefined): void => {
  if (v === undefined) delete process.env.QUANTA_BENCH_RESUME
  else process.env.QUANTA_BENCH_RESUME = v
  __resetRuntimeConfig()
}

const makeInstance = (id: string): Instance =>
  ({ id, repoPath: "/does/not/matter", goldPatch: undefined }) as unknown as Instance

beforeEach(() => {
  TMP_HOME = mkdtempSync(join(tmpdir(), "sandbox-det-"))
  process.env.QUANTA_BENCH_HOME = TMP_HOME
  __resetRuntimeConfig()
})

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.QUANTA_BENCH_HOME
  else process.env.QUANTA_BENCH_HOME = ORIG_HOME
  setResume(ORIG_RESUME)
  rmSync(TMP_HOME, { recursive: true, force: true })
})

describe("createSandbox — default OFF (byte-identical to today: random mkdtemp)", () => {
  test("two calls for the SAME instance yield DIFFERENT random paths", async () => {
    setResume(undefined) // unset ⇒ OFF
    const inst = makeInstance("psf__requests-5414")
    const a = await createSandbox(inst)
    const b = await createSandbox(inst)
    expect(a).not.toBe(b) // random suffix at both levels ⇒ distinct
    // shape: <root>/bench-<opaque-id>-XXXX/repo-XXXX
    expect(a).toMatch(/\/bench-[0-9a-f]{20}-[^/]+\/repo-[^/]+$/)
    expect(a).not.toContain(inst.id)
    await cleanupSandbox(a)
    await cleanupSandbox(b)
  })

  test('explicit falsy ("0"/"off") also stays random (gateOn vocab)', async () => {
    for (const off of ["0", "off"]) {
      setResume(off)
      const inst = makeInstance("astropy__astropy-1")
      const a = await createSandbox(inst)
      const b = await createSandbox(inst)
      expect(a).not.toBe(b)
      await cleanupSandbox(a)
      await cleanupSandbox(b)
    }
  })
})

describe("createSandbox — resume ON (deterministic instance-scoped path)", () => {
  test("two calls for the SAME instance yield the SAME deterministic path", async () => {
    setResume("1")
    const inst = makeInstance("psf__requests-5414")
    const a = await createSandbox(inst)
    const b = await createSandbox(inst)
    expect(a).toBe(b) // deterministic ⇒ stable across calls/boxes
    // shape: <root>/<opaque id>/sandbox (leaf is `sandbox`, NOT `repo` — see F1)
    expect(a).toBe(join(benchWorkRoot(), benchInstanceWorkSlug(inst.id), "sandbox"))
    expect(a).not.toContain(inst.id)
    await cleanupSandbox(a)
  })

  test("instance id is opaque: dataset text and embedded commit SHA are absent", async () => {
    setResume("on")
    const inst = makeInstance("instance_repo-deadbeefcafebabefeedface0123456789abcdef")
    const a = await createSandbox(inst)
    expect(a).toBe(join(benchWorkRoot(), benchInstanceWorkSlug(inst.id), "sandbox"))
    expect(a).not.toContain("deadbeef")
    expect(a).not.toContain(inst.id)
    await cleanupSandbox(a)
  })

  test("a pre-existing deterministic dir is RESET (clean checkout, not reused dirty)", async () => {
    setResume("true")
    const inst = makeInstance("psf__requests-5414")
    // First call mints the path; plant a marker inside it.
    const first = await createSandbox(inst)
    const marker = join(first, "STALE_MARKER")
    writeFileSync(marker, "leftover from a prior local re-run")
    expect(existsSync(marker)).toBe(true)
    // Second call for the same instance must wipe + recreate ⇒ marker gone.
    const second = await createSandbox(inst)
    expect(second).toBe(first)
    expect(existsSync(marker)).toBe(false) // clean checkout
    expect(existsSync(second)).toBe(true) // dir itself recreated
    await cleanupSandbox(second)
  })
})

describe("F1 regression — deterministic sandbox MUST NOT collide with the prepared repo", () => {
  // Before the leaf=`sandbox` fix, createSandbox returned <root>/<id>/repo == the
  // driver's prepared checkout (instance.repoPath). createSandbox then rm -rf'd the
  // prepared repo and copyRepo did cp(src===dest) → ERR_FS_CP_EINVAL → every resume
  // instance failed on its own happy path. This test exercises the real composition.
  test("createSandbox keeps the prepared repo; copyRepo cp has distinct src/dest", async () => {
    setResume("1")
    const id = "psf__requests-5414"
    const repoPath = join(benchWorkRoot(), id, "repo") // the driver's prepared checkout
    mkdirSync(repoPath, { recursive: true })
    writeFileSync(join(repoPath, "SOURCE_FILE"), "checked-out source")
    const inst = { id, repoPath, goldPatch: undefined } as unknown as Instance

    const sandbox = await createSandbox(inst)
    expect(sandbox).not.toBe(repoPath) // distinct ⇒ no self-wipe, no cp src===dest
    expect(sandbox).toBe(join(benchWorkRoot(), benchInstanceWorkSlug(id), "sandbox"))
    expect(existsSync(join(repoPath, "SOURCE_FILE"))).toBe(true) // prepared repo survived createSandbox
    await copyRepo(inst, sandbox) // would throw ERR_FS_CP_EINVAL if src===dest
    expect(existsSync(join(sandbox, "SOURCE_FILE"))).toBe(true) // source landed in the sandbox
    await cleanupSandbox(sandbox)
  })
})

describe("cleanupSandbox works for both modes", () => {
  test("ON-mode cleanup removes the instance-scoped parent dir", async () => {
    setResume("yes")
    const inst = makeInstance("psf__requests-5414")
    const sandbox = await createSandbox(inst)
    expect(existsSync(sandbox)).toBe(true)
    await cleanupSandbox(sandbox)
    // cleanupSandbox removes dirname(sandbox) = the <id> parent.
    expect(existsSync(dirname(sandbox))).toBe(false)
  })
})
