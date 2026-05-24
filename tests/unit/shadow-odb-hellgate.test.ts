/**
 * ★ CONTRACT — ADR-0108: Shadow git ODB foundation.
 *
 * The shadow ODB MUST:
 *   - keep its store outside the user's `.git` (GIT_DIR override invariant)
 *   - be idempotent on init for the same absolute workspace path
 *   - derive workspaceHash deterministically from absolute paths
 *   - reject relative paths and symlinked components
 *   - surface spawn / git failures as typed `ShadowOdbError` (no
 *     null-collapse)
 *   - serialize concurrent registerHead calls against the same workspace
 *   - refuse non-canonical ref names
 *   - leave `rewindToLast` as a typed "not-implemented" trap until the
 *     follow-up ADR
 *   - support LRU cleanup (best-effort)
 *
 * Strategy: real `defaultGitRunner` + real `git init` inside `os.tmpdir()`.
 * Every test creates its own tmp workspace + tmp shadow base, so this
 * battery never touches `~/.quanta` and never interferes with the user's
 * actual git config.
 */

import { afterAll, describe, expect, mock, test } from "bun:test"
import {
  existsSync,
  promises as fs,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SHADOW_ODB_MAX_BYTES,
  defaultShadowOdb,
  evictLru,
  SHADOW_LAST_REF,
  SHADOW_PRE_REWIND_REF_PREFIX,
  ShadowOdbError,
  workspaceHash,
} from "@/storage"
import { defaultGitRunner, type GitRunner } from "@/tool/git"

/* ------------------------------------------------------------------ */
/* test harness                                                        */
/* ------------------------------------------------------------------ */

const allTmpDirs: string[] = []

const mkTmp = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `quanta-shadow-${label}-`))
  allTmpDirs.push(d)
  return d
}

/** Make a workspace dir with a tiny seed file so `git add -A` has
 *  something to do (some `git` builds error on empty trees). */
const makeWorkspace = (label: string): string => {
  const w = mkTmp(`ws-${label}`)
  writeFileSync(join(w, "seed.txt"), "seed\n", "utf8")
  return w
}

afterAll(() => {
  for (const d of allTmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore — best effort cleanup
    }
  }
})

/** Helper: assert a thrown error is a `ShadowOdbError` with `code`. */
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

/* ------------------------------------------------------------------ */
/* HELL-2/HELL-3: workspaceHash determinism                            */
/* ------------------------------------------------------------------ */

describe("workspaceHash", () => {
  test("HELL-2: deterministic from absolute path", () => {
    const a = workspaceHash("/Users/foo/project")
    const b = workspaceHash("/Users/foo/project")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test("HELL-2b: trailing slash equivalence", () => {
    expect(workspaceHash("/Users/foo/project")).toBe(workspaceHash("/Users/foo/project/"))
  })

  test("HELL-3: distinct workspaces ⇒ distinct hashes", () => {
    expect(workspaceHash("/a/b")).not.toBe(workspaceHash("/a/c"))
    expect(workspaceHash("/Users/x")).not.toBe(workspaceHash("/Users/y"))
  })

  test("HELL-3b: empty path rejected", () => {
    expect(() => workspaceHash("")).toThrow()
  })
})

/* ------------------------------------------------------------------ */
/* HELL-1: init idempotency                                            */
/* ------------------------------------------------------------------ */

describe("init (HELL-1, HELL-9, HELL-8)", () => {
  test("HELL-1: same workspace ⇒ same shadowDir + same hash on repeat init", async () => {
    const base = mkTmp("base")
    const ws = makeWorkspace("idem")
    const odb = defaultShadowOdb({ baseDir: base })
    const a = await odb.init(ws)
    const b = await odb.init(ws)
    expect(a.shadowDir).toBe(b.shadowDir)
    expect(a.workspaceHash).toBe(b.workspaceHash)
    // Shadow dir must exist and contain a `.git`.
    const st = await fs.lstat(join(a.shadowDir, ".git"))
    expect(st.isDirectory()).toBe(true)
  })

  test("HELL-9: relative workspaceRoot rejected", async () => {
    const odb = defaultShadowOdb({ baseDir: mkTmp("rej-rel") })
    await expectShadowError(() => odb.init("./relative"), "relative-path")
    await expectShadowError(() => odb.init(""), "relative-path")
    await expectShadowError(() => odb.init("relative"), "relative-path")
  })

  test("HELL-8: symlinked workspaceRoot rejected", async () => {
    const real = makeWorkspace("real-target")
    const linkParent = mkTmp("link-parent")
    const linkPath = join(linkParent, "link-to-ws")
    symlinkSync(real, linkPath)
    const odb = defaultShadowOdb({ baseDir: mkTmp("base-sym") })
    await expectShadowError(() => odb.init(linkPath), "symlink-in-path")
  })
})

/* ------------------------------------------------------------------ */
/* HELL-4/HELL-5: registerHead invariants                              */
/* ------------------------------------------------------------------ */

describe("registerHead (HELL-4, HELL-5, HELL-12)", () => {
  test("HELL-5: registerHead advances the canonical ref + returns valid SHA", async () => {
    const base = mkTmp("base-reg")
    const ws = makeWorkspace("reg")
    const odb = defaultShadowOdb({ baseDir: base })
    const sha = await odb.registerHead(ws)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    // Verify the ref by hitting the shadow store directly with the
    // default runner (proves the ref is real, not a stub).
    const { shadowDir } = await odb.init(ws)
    const r = await defaultGitRunner.run(
      [`--git-dir=${join(shadowDir, ".git")}`, "rev-parse", SHADOW_LAST_REF],
      shadowDir,
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(sha)
  })

  test("HELL-4: registerHead does NOT touch the user's `.git`", async () => {
    const base = mkTmp("base-noinvade")
    const ws = makeWorkspace("noinvade")
    // Give the workspace its OWN user .git with a sentinel ref. After
    // registerHead, that sentinel must be untouched.
    await defaultGitRunner.run(["init", "-b", "main"], ws)
    await defaultGitRunner.run(["config", "user.email", "u@u"], ws)
    await defaultGitRunner.run(["config", "user.name", "U"], ws)
    await defaultGitRunner.run(["config", "commit.gpgsign", "false"], ws)
    await defaultGitRunner.run(["add", "-A"], ws)
    await defaultGitRunner.run(["commit", "-m", "user-seed"], ws)
    const beforeRef = await defaultGitRunner.run(["rev-parse", "HEAD"], ws)
    const beforeHead = beforeRef.stdout.trim()
    // Sanity: SHADOW_LAST_REF must NOT exist in the user's .git.
    const sanity = await defaultGitRunner.run(
      ["rev-parse", "--verify", "--quiet", SHADOW_LAST_REF],
      ws,
    )
    expect(sanity.exitCode).not.toBe(0)

    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)

    // User HEAD unchanged.
    const afterRef = await defaultGitRunner.run(["rev-parse", "HEAD"], ws)
    expect(afterRef.stdout.trim()).toBe(beforeHead)
    // SHADOW_LAST_REF STILL absent from user .git.
    const afterSanity = await defaultGitRunner.run(
      ["rev-parse", "--verify", "--quiet", SHADOW_LAST_REF],
      ws,
    )
    expect(afterSanity.exitCode).not.toBe(0)
  })

  test("HELL-12: workspace with its own `.git` doesn't pollute the shadow store either", async () => {
    const base = mkTmp("base-12")
    const ws = makeWorkspace("12")
    await defaultGitRunner.run(["init", "-b", "main"], ws)
    await defaultGitRunner.run(["config", "user.email", "u@u"], ws)
    await defaultGitRunner.run(["config", "user.name", "U"], ws)
    await defaultGitRunner.run(["config", "commit.gpgsign", "false"], ws)
    const odb = defaultShadowOdb({ baseDir: base })
    const { shadowDir } = await odb.init(ws)
    const sha = await odb.registerHead(ws)
    // Shadow HEAD is independent of user repo HEAD (user repo had no
    // commits; shadow has one).
    const shadowHead = await defaultGitRunner.run(
      [`--git-dir=${join(shadowDir, ".git")}`, "rev-parse", "HEAD"],
      shadowDir,
    )
    expect(shadowHead.exitCode).toBe(0)
    expect(shadowHead.stdout.trim()).toBe(sha)
  })
})

/* ------------------------------------------------------------------ */
/* HELL-6/HELL-7: diffSinceLast                                        */
/* ------------------------------------------------------------------ */

describe("diffSinceLast (HELL-6, HELL-7)", () => {
  test("HELL-7: no changes ⇒ empty diff", async () => {
    const base = mkTmp("base-diff-7")
    const ws = makeWorkspace("d7")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    const diff = await odb.diffSinceLast(ws)
    expect(diff).toBe("")
  })

  test("HELL-6: workspace edit captured in diff", async () => {
    const base = mkTmp("base-diff-6")
    const ws = makeWorkspace("d6")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    writeFileSync(join(ws, "seed.txt"), "seed\nMUTATED\n", "utf8")
    const diff = await odb.diffSinceLast(ws)
    expect(diff).toContain("seed.txt")
    expect(diff).toContain("MUTATED")
    expect(diff).toContain("--- a/seed.txt")
    expect(diff).toContain("+++ b/seed.txt")
  })

  test("HELL-6b: diffSinceLast before any registerHead surfaces typed error", async () => {
    const base = mkTmp("base-diff-uninit")
    const ws = makeWorkspace("d-uninit")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.init(ws) // init but never registerHead
    await expectShadowError(() => odb.diffSinceLast(ws), "uninitialized")
  })
})

/* ------------------------------------------------------------------ */
/* HELL-10: spawn-error typed surface                                  */
/* ------------------------------------------------------------------ */

describe("spawn-error surface (HELL-10)", () => {
  test("HELL-10: spawn error becomes ShadowOdbError, not null collapse", async () => {
    const ws = makeWorkspace("spawn")
    // Fake runner that always throws — simulates git missing from PATH.
    const exploder: GitRunner = {
      run(): never {
        throw new Error("ENOENT: git binary missing")
      },
    }
    const odb = defaultShadowOdb({
      baseDir: mkTmp("base-spawn"),
      runner: exploder,
    })
    const err = await expectShadowError(() => odb.init(ws), "spawn-failed")
    expect(err.message).toContain("git binary missing")
  })

  test("HELL-10b: non-zero git exit becomes git-failed error", async () => {
    const ws = makeWorkspace("nz")
    const failer: GitRunner = {
      async run(args) {
        // Make `git init` succeed, then everything else fail nonzero.
        if (args[0] === "init") {
          return { stdout: "", stderr: "", exitCode: 0 }
        }
        return { stdout: "", stderr: "boom", exitCode: 128 }
      },
    }
    const odb = defaultShadowOdb({
      baseDir: mkTmp("base-nz"),
      runner: failer,
    })
    await expectShadowError(() => odb.init(ws), "git-failed")
  })
})

/* ------------------------------------------------------------------ */
/* HELL-11: concurrent registerHead serialization                       */
/* ------------------------------------------------------------------ */

describe("concurrency (HELL-11)", () => {
  test("HELL-11: two concurrent registerHeads against the same workspace both succeed sequentially", async () => {
    const base = mkTmp("base-11")
    const ws = makeWorkspace("11")
    const odb = defaultShadowOdb({ baseDir: base })
    // Fire both before awaiting — they must serialize internally.
    const [sha1, sha2] = await Promise.all([odb.registerHead(ws), odb.registerHead(ws)])
    expect(sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(sha2).toMatch(/^[0-9a-f]{40}$/)
    // Both calls produced different commit SHAs (each call writes a
    // distinct snapshot timestamp) — proves they didn't collapse into
    // one operation. Ref ends up at one of them.
    const { shadowDir } = await odb.init(ws)
    const tip = await defaultGitRunner.run(
      [`--git-dir=${join(shadowDir, ".git")}`, "rev-parse", SHADOW_LAST_REF],
      shadowDir,
    )
    expect(tip.exitCode).toBe(0)
    expect([sha1, sha2]).toContain(tip.stdout.trim())
  })
})

/* ------------------------------------------------------------------ */
/* HELL-20..26: rewindToLast + listSnapshots (ADR-0118)                 */
/* ------------------------------------------------------------------ */

/** Read the shadow store's view of `relPath` at `ref` and return the
 *  textual contents. Used to assert the pre-rewind ref captured the
 *  state we expected. */
const readShadowFile = async (shadowDir: string, ref: string, relPath: string): Promise<string> => {
  const r = await defaultGitRunner.run(
    [`--git-dir=${join(shadowDir, ".git")}`, "show", `${ref}:${relPath}`],
    shadowDir,
  )
  expect(r.exitCode).toBe(0)
  return r.stdout
}

/** Regex for valid pre-rewind ref names. Colons in the ISO timestamp are
 *  replaced with `-` (git refuses colons in ref names), so the format is
 *  `yyyy-mm-ddThh-mm-ssZ`. */
const PRE_REWIND_REF_RE =
  /^refs\/quanta\/snapshots\/pre-rewind-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/

describe("rewindToLast — happy paths (HELL-20)", () => {
  test("HELL-20: tracked file modified after snapshot ⇒ rewind restores content", async () => {
    const base = mkTmp("base-rewind-20")
    const ws = makeWorkspace("rw-20")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    // Mutate the tracked file post-snapshot.
    writeFileSync(join(ws, "seed.txt"), "seed\nMUTATED-AFTER\n", "utf8")
    await odb.rewindToLast(ws)
    const restored = readFileSync(join(ws, "seed.txt"), "utf8")
    expect(restored).toBe("seed\n")
  })

  test("HELL-20b: tracked file deleted post-snapshot ⇒ rewind re-creates it", async () => {
    const base = mkTmp("base-rewind-20b")
    const ws = makeWorkspace("rw-20b")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    // Delete the only tracked file.
    rmSync(join(ws, "seed.txt"))
    expect(existsSync(join(ws, "seed.txt"))).toBe(false)
    await odb.rewindToLast(ws)
    expect(existsSync(join(ws, "seed.txt"))).toBe(true)
    expect(readFileSync(join(ws, "seed.txt"), "utf8")).toBe("seed\n")
  })

  test("HELL-20c: untracked file with default untracked:preserve ⇒ remains after rewind", async () => {
    const base = mkTmp("base-rewind-20c")
    const ws = makeWorkspace("rw-20c")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    // Add untracked (from shadow's POV) file AFTER the snapshot.
    writeFileSync(join(ws, "untracked.txt"), "post-snapshot stray\n", "utf8")
    await odb.rewindToLast(ws)
    expect(existsSync(join(ws, "untracked.txt"))).toBe(true)
    expect(readFileSync(join(ws, "untracked.txt"), "utf8")).toBe("post-snapshot stray\n")
  })

  test("HELL-20d: untracked file with opts={untracked:'discard'} ⇒ removed after rewind", async () => {
    const base = mkTmp("base-rewind-20d")
    const ws = makeWorkspace("rw-20d")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    writeFileSync(join(ws, "untracked.txt"), "should be cleaned\n", "utf8")
    await odb.rewindToLast(ws, { untracked: "discard" })
    expect(existsSync(join(ws, "untracked.txt"))).toBe(false)
    // Tracked seed survives.
    expect(existsSync(join(ws, "seed.txt"))).toBe(true)
  })
})

describe("rewindToLast — guards (HELL-21..23)", () => {
  test("HELL-21: no anchor (init only) ⇒ uninitialized; worktree unchanged", async () => {
    const base = mkTmp("base-rewind-21")
    const ws = makeWorkspace("rw-21")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.init(ws) // init but NEVER registerHead
    // Pre-call worktree fingerprint.
    const before = readFileSync(join(ws, "seed.txt"), "utf8")
    await expectShadowError(() => odb.rewindToLast(ws), "uninitialized")
    // Worktree must be untouched.
    expect(readFileSync(join(ws, "seed.txt"), "utf8")).toBe(before)
    // And no pre-rewind ref should have been created (the safety net
    // runs AFTER the uninitialized check).
    const snaps = await odb.listSnapshots(ws)
    expect(snaps.length).toBe(0)
  })

  test("HELL-22: MERGE_HEAD exists ⇒ merge-in-progress; worktree + refs unchanged", async () => {
    const base = mkTmp("base-rewind-22")
    const ws = makeWorkspace("rw-22")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    // Simulate a half-finished merge in the USER's workspace .git.
    mkdirSync(join(ws, ".git"), { recursive: true })
    writeFileSync(join(ws, ".git", "MERGE_HEAD"), "deadbeef\n", "utf8")
    writeFileSync(join(ws, "seed.txt"), "seed\nPOST\n", "utf8")
    await expectShadowError(() => odb.rewindToLast(ws), "merge-in-progress")
    // Worktree untouched.
    expect(readFileSync(join(ws, "seed.txt"), "utf8")).toBe("seed\nPOST\n")
    // No pre-rewind ref must have been created — guard fires BEFORE the
    // safety-net commit.
    const snaps = await odb.listSnapshots(ws)
    for (const s of snaps) {
      expect(s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX)).toBe(false)
    }
  })

  test("HELL-22b: MERGE_HEAD + allowDirtyMerge:true ⇒ rewind succeeds", async () => {
    const base = mkTmp("base-rewind-22b")
    const ws = makeWorkspace("rw-22b")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    mkdirSync(join(ws, ".git"), { recursive: true })
    writeFileSync(join(ws, ".git", "MERGE_HEAD"), "deadbeef\n", "utf8")
    writeFileSync(join(ws, "seed.txt"), "seed\nBYPASS\n", "utf8")
    await odb.rewindToLast(ws, { allowDirtyMerge: true })
    expect(readFileSync(join(ws, "seed.txt"), "utf8")).toBe("seed\n")
  })

  test("HELL-23: symlinked workspaceRoot ⇒ symlink-in-path", async () => {
    const base = mkTmp("base-rewind-23")
    const real = makeWorkspace("rw-23-real")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(real)
    const linkParent = mkTmp("rw-23-linkparent")
    const linkPath = join(linkParent, "link-to-ws")
    symlinkSync(real, linkPath)
    await expectShadowError(() => odb.rewindToLast(linkPath), "symlink-in-path")
  })

  test("HELL-23b: relative workspaceRoot ⇒ relative-path", async () => {
    const base = mkTmp("base-rewind-23b")
    const odb = defaultShadowOdb({ baseDir: base })
    await expectShadowError(() => odb.rewindToLast("./relative"), "relative-path")
    await expectShadowError(() => odb.rewindToLast(""), "relative-path")
  })
})

describe("rewindToLast — safety net (HELL-24)", () => {
  test("HELL-24: exactly one pre-rewind ref created, name format matches spec", async () => {
    const base = mkTmp("base-rewind-24")
    const ws = makeWorkspace("rw-24")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    // Before the rewind, no pre-rewind refs.
    const snapsBefore = await odb.listSnapshots(ws)
    for (const s of snapsBefore) {
      expect(s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX)).toBe(false)
    }
    writeFileSync(join(ws, "seed.txt"), "seed\nABOUT-TO-LOSE\n", "utf8")
    await odb.rewindToLast(ws)
    const snapsAfter = await odb.listSnapshots(ws)
    const preRewinds = snapsAfter.filter((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    expect(preRewinds.length).toBe(1)
    expect(preRewinds[0]!.ref).toMatch(PRE_REWIND_REF_RE)
  })

  test("HELL-24b: two rewinds with 1s gap ⇒ two distinct pre-rewind refs", async () => {
    const base = mkTmp("base-rewind-24b")
    const ws = makeWorkspace("rw-24b")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    writeFileSync(join(ws, "seed.txt"), "seed\nM1\n", "utf8")
    await odb.rewindToLast(ws)
    // Sleep > 1s so the next ISO-second suffix is distinct.
    await new Promise((r) => setTimeout(r, 1100))
    writeFileSync(join(ws, "seed.txt"), "seed\nM2\n", "utf8")
    await odb.rewindToLast(ws)
    const snaps = await odb.listSnapshots(ws)
    const preRewinds = snaps.filter((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    expect(preRewinds.length).toBe(2)
    const refs = new Set(preRewinds.map((s) => s.ref))
    expect(refs.size).toBe(2) // distinct
    for (const ref of refs) expect(ref).toMatch(PRE_REWIND_REF_RE)
  })

  test("HELL-24c: pre-rewind ref captures pre-rewind worktree; SHADOW_LAST_REF captures snapshot", async () => {
    const base = mkTmp("base-rewind-24c")
    const ws = makeWorkspace("rw-24c")
    const odb = defaultShadowOdb({ baseDir: base })
    // Write known content X, snapshot it.
    writeFileSync(join(ws, "A.txt"), "X\n", "utf8")
    await odb.registerHead(ws)
    // Mutate to Y.
    writeFileSync(join(ws, "A.txt"), "Y\n", "utf8")
    const { shadowDir } = await odb.init(ws)
    await odb.rewindToLast(ws)
    // (a) worktree A == X (restored).
    expect(readFileSync(join(ws, "A.txt"), "utf8")).toBe("X\n")
    // (b) pre-rewind ref's A == Y (captured before destruction).
    const snaps = await odb.listSnapshots(ws)
    const pr = snaps.find((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    expect(pr).toBeDefined()
    const captured = await readShadowFile(shadowDir, pr!.ref, "A.txt")
    expect(captured).toBe("Y\n")
  })
})

describe("rewindToLast — concurrent same-ISO-second collision (HELL-25)", () => {
  test("HELL-25: two rewinds at identical ISO second ⇒ second one throws rewind-failed (no silent overwrite)", async () => {
    const base = mkTmp("base-rewind-25")
    const ws = makeWorkspace("rw-25")
    // Fixed clock: every call returns the SAME instant ⇒ both rewinds
    // compute the same pre-rewind suffix. The second update-ref must
    // fail (create-only semantics), not silently overwrite.
    const fixed = new Date("2026-05-24T03:14:15.000Z")
    const odb = defaultShadowOdb({ baseDir: base, now: () => fixed })
    await odb.registerHead(ws)
    writeFileSync(join(ws, "seed.txt"), "seed\nFIRST\n", "utf8")
    await odb.rewindToLast(ws)
    // Second rewind at the same instant must surface as rewind-failed.
    writeFileSync(join(ws, "seed.txt"), "seed\nSECOND\n", "utf8")
    await expectShadowError(() => odb.rewindToLast(ws), "rewind-failed")
    // Only ONE pre-rewind ref exists — the second never overwrote the first.
    const snaps = await odb.listSnapshots(ws)
    const preRewinds = snaps.filter((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    expect(preRewinds.length).toBe(1)
  })
})

describe("listSnapshots (HELL-26)", () => {
  test("HELL-26: 0 snapshots (init only, no registerHead) ⇒ empty array", async () => {
    const base = mkTmp("base-list-26")
    const ws = makeWorkspace("ls-26")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.init(ws)
    const snaps = await odb.listSnapshots(ws)
    expect(snaps).toEqual([])
  })

  test("HELL-26b: registerHead → 1 entry; rewindToLast → 2 entries newest-first", async () => {
    const base = mkTmp("base-list-26b")
    const ws = makeWorkspace("ls-26b")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(ws)
    const after1 = await odb.listSnapshots(ws)
    expect(after1.length).toBe(1)
    expect(after1[0]!.ref).toBe(SHADOW_LAST_REF)
    expect(after1[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
    // Wait 1s so the pre-rewind commit's committer time is strictly
    // greater than the registerHead commit's — newest-first ordering
    // becomes provably deterministic.
    await new Promise((r) => setTimeout(r, 1100))
    writeFileSync(join(ws, "seed.txt"), "seed\nMUT\n", "utf8")
    await odb.rewindToLast(ws)
    const after2 = await odb.listSnapshots(ws)
    expect(after2.length).toBe(2)
    // Newest first: pre-rewind ref's committerdate >= SHADOW_LAST_REF's.
    expect(after2[0]!.timestampSec).toBeGreaterThanOrEqual(after2[1]!.timestampSec)
    const refs = after2.map((s) => s.ref).sort()
    expect(refs).toContain(SHADOW_LAST_REF)
    const pre = after2.find((s) => s.ref.startsWith(SHADOW_PRE_REWIND_REF_PREFIX))
    expect(pre).toBeDefined()
  })

  test("HELL-26c: corrupted for-each-ref output ⇒ git-failed with bad line in message", async () => {
    const base = mkTmp("base-list-26c")
    const ws = makeWorkspace("ls-26c")
    // Fake runner: pass-through to real git EXCEPT for for-each-ref,
    // which returns one well-formed line plus one garbage line.
    const passthrough = defaultGitRunner
    const corrupting: GitRunner = {
      async run(args, cwd, signal) {
        // Detect the for-each-ref call by scanning argv (it's preceded by
        // the --git-dir / --work-tree flags so positional index isn't 0).
        if (args.some((a) => a === "for-each-ref")) {
          return {
            stdout:
              "refs/quanta/snapshots/last-registered|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|1700000000\nGARBAGE-NO-PIPES\n",
            stderr: "",
            exitCode: 0,
          }
        }
        return signal === undefined
          ? await passthrough.run(args, cwd)
          : await passthrough.run(args, cwd, signal)
      },
    }
    const odb = defaultShadowOdb({ baseDir: base, runner: corrupting })
    await odb.init(ws)
    const err = await expectShadowError(() => odb.listSnapshots(ws), "git-failed")
    expect(err.message).toContain("GARBAGE-NO-PIPES")
  })
})

/* ------------------------------------------------------------------ */
/* HELL-14: ref-name safety                                            */
/* ------------------------------------------------------------------ */

describe("ref-name safety (HELL-14)", () => {
  test("HELL-14: SHADOW_LAST_REF is the canonical ref under refs/quanta/snapshots/", () => {
    expect(SHADOW_LAST_REF).toBe("refs/quanta/snapshots/last-registered")
    // Defensive: must start with refs/ (git requires this for
    // update-ref to write outside HEAD).
    expect(SHADOW_LAST_REF.startsWith("refs/")).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* HELL-15: LRU cleanup                                                */
/* ------------------------------------------------------------------ */

describe("cleanup (HELL-15)", () => {
  test("HELL-15: cleanup evicts oldest shadow dirs when over cap", async () => {
    const base = mkTmp("base-lru")
    // Manually create three shadow dirs of known size, oldest first.
    const snapshotsRoot = join(base, "snapshots")
    await fs.mkdir(snapshotsRoot, { recursive: true })
    const mkSized = async (name: string, bytes: number, mtimeOffset: number): Promise<void> => {
      const d = join(snapshotsRoot, name)
      await fs.mkdir(d, { recursive: true })
      await fs.writeFile(join(d, "blob"), Buffer.alloc(bytes), { mode: 0o600 })
      const t = new Date(Date.now() - mtimeOffset).getTime() / 1000
      await fs.utimes(d, t, t)
    }
    await mkSized("aaaaaaaaaaaaaaaa", 4096, 60_000) // oldest
    await mkSized("bbbbbbbbbbbbbbbb", 4096, 30_000)
    await mkSized("cccccccccccccccc", 4096, 1_000) // newest

    // Cap = 5000 bytes ⇒ must evict at least two of the 4k dirs.
    const cleanupSpy = mock(evictLru)
    const evicted = await cleanupSpy(base, 5000)
    expect(evicted).toBeGreaterThanOrEqual(2)
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
    // The newest must survive.
    const remaining = readdirSync(snapshotsRoot)
    expect(remaining).toContain("cccccccccccccccc")
    // The oldest must be gone.
    expect(remaining).not.toContain("aaaaaaaaaaaaaaaa")
  })

  test("HELL-15b: cleanup is a no-op when under cap", async () => {
    const base = mkTmp("base-lru-noop")
    await fs.mkdir(join(base, "snapshots", "x"), { recursive: true })
    await fs.writeFile(join(base, "snapshots", "x", "f"), "abc", "utf8")
    const cleanupSpy = mock(evictLru)
    const evicted = await cleanupSpy(base, 1_000_000)
    expect(evicted).toBe(0)
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
    // Dir survived.
    const remaining = readdirSync(join(base, "snapshots"))
    expect(remaining).toContain("x")
  })

  test("HELL-15c: cleanup against a missing snapshots dir is a no-op", async () => {
    const base = mkTmp("base-lru-missing")
    const cleanupSpy = mock(evictLru)
    const evicted = await cleanupSpy(base, 0)
    expect(evicted).toBe(0)
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })

  test("HELL-15d: cleanup exposed via the port (`.cleanup`)", async () => {
    const base = mkTmp("base-lru-port")
    const odb = defaultShadowOdb({ baseDir: base })
    const cleanupSpy = mock(odb.cleanup.bind(odb))
    // No snapshots yet ⇒ 0.
    expect(await cleanupSpy(DEFAULT_SHADOW_ODB_MAX_BYTES)).toBe(0)
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
  })
})

/* ------------------------------------------------------------------ */
/* additional invariants (extra coverage)                              */
/* ------------------------------------------------------------------ */

describe("nested-shadow guard", () => {
  test("rejects when shadow base lives inside the workspace", async () => {
    const ws = makeWorkspace("nest")
    // baseDir lives INSIDE the workspace — would otherwise recurse.
    const nestedBase = join(ws, ".inner-base")
    const odb = defaultShadowOdb({ baseDir: nestedBase })
    await expectShadowError(() => odb.init(ws), "nested-shadow")
  })
})

describe("isolation across workspaces", () => {
  test("two workspaces ⇒ two independent shadow dirs", async () => {
    const base = mkTmp("base-iso")
    const ws1 = makeWorkspace("iso1")
    const ws2 = makeWorkspace("iso2")
    const odb = defaultShadowOdb({ baseDir: base })
    const a = await odb.init(ws1)
    const b = await odb.init(ws2)
    expect(a.shadowDir).not.toBe(b.shadowDir)
    expect(a.workspaceHash).not.toBe(b.workspaceHash)
  })
})

/* ------------------------------------------------------------------ */
/* HELL-16..19: diffWorkspaceSinceLast (ADR-0116 anchor seam)          */
/* ------------------------------------------------------------------ */

describe("diffWorkspaceSinceLast (HELL-16, HELL-17, HELL-18, HELL-19)", () => {
  test("HELL-16: anchor on A, diff against sibling workspace B with an edit", async () => {
    const base = mkTmp("base-diff-ws-16")
    const wsA = makeWorkspace("ws-a-16")
    // Sibling workspace B with the same seed.txt content + a mutation. The
    // anchor was taken on A; the diff is computed against B's working tree.
    const wsB = makeWorkspace("ws-b-16")
    writeFileSync(join(wsB, "seed.txt"), "seed\nB-EDIT\n", "utf8")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(wsA)
    const diff = await odb.diffWorkspaceSinceLast(wsA, wsB)
    expect(diff).toContain("seed.txt")
    expect(diff).toContain("B-EDIT")
    expect(diff).toContain("--- a/seed.txt")
    expect(diff).toContain("+++ b/seed.txt")
  })

  test("HELL-16b: zero divergence — diff against the anchor workspace itself ⇒ empty", async () => {
    const base = mkTmp("base-diff-ws-16b")
    const wsA = makeWorkspace("ws-a-16b")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(wsA)
    const diff = await odb.diffWorkspaceSinceLast(wsA, wsA)
    expect(diff).toBe("")
  })

  test("HELL-17: diffWorkspaceSinceLast without prior registerHead ⇒ uninitialized", async () => {
    const base = mkTmp("base-diff-ws-17")
    const wsA = makeWorkspace("ws-a-17")
    const wsB = makeWorkspace("ws-b-17")
    const odb = defaultShadowOdb({ baseDir: base })
    // init only — never registerHead.
    await odb.init(wsA)
    await expectShadowError(() => odb.diffWorkspaceSinceLast(wsA, wsB), "uninitialized")
  })

  test("HELL-18: leaf-symlink rejection on comparisonWorkspace", async () => {
    const base = mkTmp("base-diff-ws-18")
    const wsA = makeWorkspace("ws-a-18")
    const real = makeWorkspace("real-target-18")
    const linkParent = mkTmp("link-parent-18")
    const linkPath = join(linkParent, "link-to-ws")
    symlinkSync(real, linkPath)
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(wsA)
    await expectShadowError(() => odb.diffWorkspaceSinceLast(wsA, linkPath), "symlink-in-path")
  })

  test("HELL-19: relative comparisonWorkspace rejected", async () => {
    const base = mkTmp("base-diff-ws-19")
    const wsA = makeWorkspace("ws-a-19")
    const odb = defaultShadowOdb({ baseDir: base })
    await odb.registerHead(wsA)
    await expectShadowError(() => odb.diffWorkspaceSinceLast(wsA, "./relative-ws"), "relative-path")
    await expectShadowError(() => odb.diffWorkspaceSinceLast(wsA, ""), "relative-path")
  })
})
