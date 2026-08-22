/**
 * ★ Hellgate — ShadowOdb rewind extensions (ADR-0122 + ADR-0123).
 *
 * 18 cases pinning:
 *   A. `restorePartial` (6)
 *   B. `markVerified`   (4)
 *   C. `rewindToVerified` (5)
 *   D. `VerifyCheckpointBridge` (3)
 *
 * Strategy: real `defaultGitRunner` + real `git init` inside
 * `os.tmpdir()` for the port-level cases (matches the existing
 * `shadow-odb-hellgate.test.ts` harness). Bridge cases use a fake
 * `ShadowOdb` minimal mock — the bridge is a 4-line forwarder and
 * needs zero filesystem.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultVerifyCheckpointBridge } from "@/agent/verify-checkpoint-bridge"
import {
  defaultShadowOdb,
  SHADOW_LAST_VERIFIED_REF,
  SHADOW_PRE_REWIND_REF_PREFIX,
  type ShadowOdb,
  ShadowOdbError,
} from "@/storage"
import { defaultGitRunner } from "@/tool/git"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const allTmpDirs: string[] = []

const mkTmp = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `quanta-shadow-ext-${label}-`))
  allTmpDirs.push(d)
  return d
}

/** Workspace with two tracked files so `restorePartial` can prove it
 *  touches ONE while leaving the OTHER alone. */
const makeWorkspace = (label: string): string => {
  const w = mkTmp(`ws-${label}`)
  writeFileSync(join(w, "a.txt"), "A-original\n", "utf8")
  writeFileSync(join(w, "b.txt"), "B-original\n", "utf8")
  return w
}

afterAll(() => {
  for (const d of allTmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

/** Assert a thrown error is a `ShadowOdbError` with `code`. */
const expectShadowError = async (
  fn: () => Promise<unknown>,
  code: ShadowOdbError["code"],
): Promise<ShadowOdbError> => {
  let caught: unknown
  try {
    await fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(ShadowOdbError)
  const err = caught as ShadowOdbError
  expect(err.code).toBe(code)
  return err
}

/* ================================================================== */
/* A. restorePartial (6)                                               */
/* ================================================================== */

describe("restorePartial — happy path + scoping (HELL-A1)", () => {
  test("HELL-A1: restore one modified file ⇒ that file restored, OTHER modified files unchanged", async () => {
    const base = mkTmp("base-a1")
    const ws = makeWorkspace("a1")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    // Mutate BOTH files post-snapshot.
    writeFileSync(join(ws, "a.txt"), "A-MUTATED\n", "utf8")
    writeFileSync(join(ws, "b.txt"), "B-MUTATED\n", "utf8")
    await odb.restorePartial(ws, ["a.txt"])
    // a.txt restored, b.txt UNTOUCHED (preserved mutation).
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("A-original\n")
    expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("B-MUTATED\n")
  })
})

describe("restorePartial — empty paths is a no-op (HELL-A2)", () => {
  test("HELL-A2: paths=[] ⇒ no safety-net ref created; worktree untouched", async () => {
    const base = mkTmp("base-a2")
    const ws = makeWorkspace("a2")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    writeFileSync(join(ws, "a.txt"), "A-MUTATED\n", "utf8")
    const snapsBefore = await odb.listSnapshots(ws)
    await odb.restorePartial(ws, [])
    // Worktree untouched.
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("A-MUTATED\n")
    // No new pre-rewind ref.
    const snapsAfter = await odb.listSnapshots(ws)
    const preBefore = snapsBefore.filter((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    const preAfter = snapsAfter.filter((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    expect(preAfter.length).toBe(preBefore.length)
  })
})

describe("restorePartial — path safety (HELL-A3..A4)", () => {
  test("HELL-A3: absolute path ⇒ rewind-failed (path-safety reject before any mutation)", async () => {
    const base = mkTmp("base-a3")
    const ws = makeWorkspace("a3")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    await expectShadowError(() => odb.restorePartial(ws, ["/etc/passwd"]), "rewind-failed")
  })

  test("HELL-A4: '..' segment in path ⇒ rewind-failed (traversal reject)", async () => {
    const base = mkTmp("base-a4")
    const ws = makeWorkspace("a4")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    await expectShadowError(() => odb.restorePartial(ws, ["src/../etc/passwd"]), "rewind-failed")
  })
})

describe("restorePartial — uninitialized + non-existent path (HELL-A5..A6)", () => {
  test("HELL-A5: never registerHead'd ⇒ uninitialized", async () => {
    const base = mkTmp("base-a5")
    const ws = makeWorkspace("a5")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.init(ws) // init but NOT registerHead
    await expectShadowError(() => odb.restorePartial(ws, ["a.txt"]), "uninitialized")
  })

  test("HELL-A6: path missing in snapshot ⇒ git checkout fails ⇒ rewind-failed", async () => {
    const base = mkTmp("base-a6")
    const ws = makeWorkspace("a6")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    // Ask for a file that never existed in the snapshot.
    await expectShadowError(() => odb.restorePartial(ws, ["never-existed.txt"]), "rewind-failed")
  })
})

/* ================================================================== */
/* B. markVerified (4)                                                 */
/* ================================================================== */

/** Read the SHA the verified ref points at, or `null` when absent. */
const readVerifiedSha = async (shadowDir: string): Promise<string | null> => {
  const r = await defaultGitRunner.run(
    [
      `--git-dir=${join(shadowDir, ".git")}`,
      "rev-parse",
      "--verify",
      "--quiet",
      SHADOW_LAST_VERIFIED_REF,
    ],
    shadowDir,
  )
  if (r.exitCode !== 0) return null
  return r.stdout.trim()
}

/** Read the SHA the registered ref points at (HEAD on the shadow store
 *  after `registerHead`). */
const readRegisteredSha = async (shadowDir: string): Promise<string | null> => {
  const r = await defaultGitRunner.run(
    [
      `--git-dir=${join(shadowDir, ".git")}`,
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/quanta/snapshots/last-registered",
    ],
    shadowDir,
  )
  if (r.exitCode !== 0) return null
  return r.stdout.trim()
}

describe("markVerified — happy + idempotent (HELL-B7..B10)", () => {
  test("HELL-B7: registerHead then markVerified ⇒ SHADOW_LAST_VERIFIED_REF == last-registered SHA", async () => {
    const base = mkTmp("base-b7")
    const ws = makeWorkspace("b7")
    const odb = defaultShadowOdb({ baseDir: base })
    const sha = await odb.registerHead(ws)
    await odb.markVerified(ws)
    const init = await odb.init(ws)
    const verified = await readVerifiedSha(init.shadowDir)
    expect(verified).toBe(sha)
  })

  test("HELL-B8: markVerified BEFORE any registerHead ⇒ uninitialized", async () => {
    const base = mkTmp("base-b8")
    const ws = makeWorkspace("b8")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.init(ws)
    await expectShadowError(() => odb.markVerified(ws), "uninitialized")
  })

  test("HELL-B9: markVerified twice in a row ⇒ idempotent (same SHA before and after)", async () => {
    const base = mkTmp("base-b9")
    const ws = makeWorkspace("b9")
    const odb = defaultShadowOdb({ baseDir: base })
    const sha = await odb.registerHead(ws)
    await odb.markVerified(ws)
    await odb.markVerified(ws)
    const init = await odb.init(ws)
    expect(await readVerifiedSha(init.shadowDir)).toBe(sha)
  })

  test("HELL-B10: registerHead → markVerified → registerHead (advances last-registered); verified ref still points at OLD sha", async () => {
    const base = mkTmp("base-b10")
    const ws = makeWorkspace("b10")
    const odb = defaultShadowOdb({ baseDir: base })
    const sha1 = await odb.registerHead(ws)
    await odb.markVerified(ws)
    // Mutate to force a distinct second snapshot SHA.
    writeFileSync(join(ws, "a.txt"), "A-second-snapshot\n", "utf8")
    const sha2 = await odb.registerHead(ws)
    expect(sha2).not.toBe(sha1)
    const init = await odb.init(ws)
    // Verified ref must NOT have advanced — still pinned to sha1.
    expect(await readVerifiedSha(init.shadowDir)).toBe(sha1)
    // And the registered ref correctly tracks sha2.
    expect(await readRegisteredSha(init.shadowDir)).toBe(sha2)
  })
})

/* ================================================================== */
/* C. rewindToVerified (5)                                             */
/* ================================================================== */

describe("rewindToVerified — happy + guards (HELL-C11..C15)", () => {
  test("HELL-C11: register → mark → modify → rewindToVerified ⇒ file restored to marked content", async () => {
    const base = mkTmp("base-c11")
    const ws = makeWorkspace("c11")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    await odb.markVerified(ws)
    writeFileSync(join(ws, "a.txt"), "A-DRIFTED-AFTER-VERIFY\n", "utf8")
    await odb.rewindToVerified(ws)
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("A-original\n")
  })

  test("HELL-C12: no markVerified ever ⇒ no-verified-anchor", async () => {
    const base = mkTmp("base-c12")
    const ws = makeWorkspace("c12")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws) // registered but NOT verified
    await expectShadowError(() => odb.rewindToVerified(ws), "no-verified-anchor")
  })

  test("HELL-C13: MERGE_HEAD exists ⇒ merge-in-progress (worktree untouched)", async () => {
    const base = mkTmp("base-c13")
    const ws = makeWorkspace("c13")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    await odb.markVerified(ws)
    mkdirSync(join(ws, ".git"), { recursive: true })
    writeFileSync(join(ws, ".git", "MERGE_HEAD"), "deadbeef\n", "utf8")
    writeFileSync(join(ws, "a.txt"), "A-POST\n", "utf8")
    await expectShadowError(() => odb.rewindToVerified(ws), "merge-in-progress")
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("A-POST\n")
  })

  test("HELL-C14: allowDirtyMerge:true bypasses MERGE_HEAD guard", async () => {
    const base = mkTmp("base-c14")
    const ws = makeWorkspace("c14")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    await odb.markVerified(ws)
    mkdirSync(join(ws, ".git"), { recursive: true })
    writeFileSync(join(ws, ".git", "MERGE_HEAD"), "deadbeef\n", "utf8")
    writeFileSync(join(ws, "a.txt"), "A-BYPASS\n", "utf8")
    await odb.rewindToVerified(ws, { allowDirtyMerge: true })
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("A-original\n")
  })

  test("HELL-C15: rewindToVerified creates a pre-rewind safety net ref", async () => {
    const base = mkTmp("base-c15")
    const ws = makeWorkspace("c15")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    await odb.markVerified(ws)
    writeFileSync(join(ws, "a.txt"), "A-ABOUT-TO-LOSE\n", "utf8")
    const before = await odb.listSnapshots(ws)
    const preBefore = before.filter((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    await odb.rewindToVerified(ws)
    const after = await odb.listSnapshots(ws)
    const preAfter = after.filter((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    expect(preAfter.length).toBe(preBefore.length + 1)
  })

  test("HELL-C16: two rewinds within the SAME instant get DISTINCT pre-rewind refs (no rewind-failed collision)", async () => {
    const base = mkTmp("base-c16")
    const ws = makeWorkspace("c16")
    // Frozen clock: BOTH rewinds compute the identical ISO timestamp. The
    // ref name must still be unique via the injected monotonic counter,
    // otherwise the second create-only ref update collides → rewind-failed.
    const frozen = new Date("2026-06-26T12:00:00.000Z")
    const odb = defaultShadowOdb({ baseDir: base, now: () => frozen })
    await odb.registerHead(ws)
    await odb.markVerified(ws)

    writeFileSync(join(ws, "a.txt"), "A-FIRST-LOSS\n", "utf8")
    await odb.rewindToVerified(ws)
    writeFileSync(join(ws, "a.txt"), "A-SECOND-LOSS\n", "utf8")
    // Pre-fix this throws ShadowOdbError("rewind-failed") because the
    // ISO-second suffix collides on the frozen clock. Must NOT throw.
    await odb.rewindToVerified(ws)

    const snaps = await odb.listSnapshots(ws)
    const preRefs = snaps
      .filter((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
      .map((s) => s.ref)
    // Two distinct safety-net refs were minted despite the frozen clock.
    expect(preRefs.length).toBe(2)
    expect(new Set(preRefs).size).toBe(2)
  })
})

/* ================================================================== */
/* D. defaultVerifyCheckpointBridge (3)                                */
/* ================================================================== */

/** Build a minimal `ShadowOdb` mock — only `markVerified` is exercised. */
const fakeOdb = (overrides?: Partial<ShadowOdb>): ShadowOdb => ({
  init: async () => ({ shadowDir: "/tmp/x", workspaceHash: "h" }),
  registerHead: async () => "sha",
  diffSinceLast: async () => "",
  diffWorkspaceSinceLast: async () => "",
  rewindToLast: async () => {},
  restorePartial: async () => {},
  markVerified: async () => {},
  rewindToVerified: async () => {},
  listSnapshots: async () => [],
  rewindToRef: async () => {
    throw new Error("unexpected rewindToRef call")
  },
  restorePartialFromRef: async () => {
    throw new Error("unexpected restorePartialFromRef call")
  },
  diffSinceRef: async () => {
    throw new Error("unexpected diffSinceRef call")
  },
  cleanup: async () => 0,
  ...(overrides ?? {}),
})

describe("VerifyCheckpointBridge (HELL-D16..D18)", () => {
  test("HELL-D16: odb absent ⇒ onVerifySuccess is a silent no-op (no throw)", async () => {
    const bridge = defaultVerifyCheckpointBridge(undefined)
    // Must not throw, must resolve.
    await bridge.onVerifySuccess("/any/workspace")
  })

  test("HELL-D17: odb.markVerified throws ⇒ onVerifySuccess swallows the error", async () => {
    let called = false
    const odb = fakeOdb({
      markVerified: async () => {
        called = true
        throw new ShadowOdbError("uninitialized", "no anchor")
      },
    })
    const bridge = defaultVerifyCheckpointBridge(odb)
    // Must not throw — observability must never break verify path.
    await bridge.onVerifySuccess("/work/proj")
    expect(called).toBe(true)
  })

  test("HELL-D18: happy ⇒ markVerified called with the workspace path", async () => {
    let seen: string | undefined
    const odb = fakeOdb({
      markVerified: async (ws) => {
        seen = ws
      },
    })
    const bridge = defaultVerifyCheckpointBridge(odb)
    await bridge.onVerifySuccess("/work/proj-x")
    expect(seen).toBe("/work/proj-x")
    // Filesystem assertion: the verified-ref existence check is covered
    // in HELL-B7; this case only validates the bridge's forwarding shape.
    expect(existsSync("/tmp")).toBe(true) // sanity
  })
})
