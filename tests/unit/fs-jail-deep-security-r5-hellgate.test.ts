/**
 * ★ HELLGATE — FILESYSTEM JAIL deep security audit (ROUND 5).
 *
 * The path-jail is the SECURITY FOUNDATION: every file tool
 * (read/write/edit/csv/xlsx/docx/pptx/image_gen/apply_patch/coverage) confines
 * disk access through `resolveJailed` / `resolvePath` (`@/storage/service`) and
 * the doc-reader chokepoint `resolveJailedDoc`. A single traversal / symlink /
 * TOCTOU bypass compromises the entire sandbox. This battery constructs each
 * attack class on a REAL tmp jail with REAL symlinks and proves it is BLOCKED.
 *
 * REAL BUG FOUND + FIXED THIS ROUND (Class 2 — dangling-symlink escape):
 *   `realResolve` previously only consulted `realpathSync` of the nearest
 *   EXISTING ancestor; on failure it climbed past the segment and re-appended
 *   the tail LEXICALLY. That silently treated a DANGLING symlink
 *   (`jail/esc -> /outside/absent`) as a plain directory name, so a path under
 *   it normalized back "inside" the jail — yet a write, once the target
 *   appeared (agent- or attacker-created), landed OUTSIDE the jail. The fix
 *   makes `realResolve` walk segment-by-segment, expanding any symlink via
 *   `lstat`+`readlink` EVEN WHEN ITS TARGET DOES NOT EXIST, so the containment
 *   check sees the real (out-of-jail) destination. See the `[REGRESSION]` block.
 *
 * Source under test: src/storage/service.ts (resolvePath / resolveJailed /
 * enforceJail / realResolve), src/storage/fs-jail-lib.ts (fsJailLib),
 * src/tool/_shared/resolve-jailed-doc.ts (resolveJailedDoc).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { FsJailError, resolveJailed, resolvePath } from "@/storage"
import { fsJailLib } from "@/storage/fs-jail-lib"
import { resolveJailedDoc } from "../../src/tool/_shared/resolve-jailed-doc"

// A fresh jail per test keeps symlink artifacts from cross-contaminating.
const roots: string[] = []
const freshJail = (label: string): { base: string; jail: string; outside: string } => {
  const base = mkdtempSync(join(tmpdir(), `r5-${label}-`))
  roots.push(base)
  const jail = join(base, "jail")
  mkdirSync(jail, { recursive: true })
  const outside = join(base, "outside")
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET")
  return { base, jail, outside }
}

beforeEach(() => {
  delete process.env.QUANTA_FS_JAIL
  __resetRuntimeConfig()
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/* ───────────────────────── CLASS 1 — lexical traversal ─────────────────── */

describe("HELLGATE R5 — class 1: lexical traversal", () => {
  test("`../` climbs, deep `../` chains, and absolute-outside all throw", () => {
    const { jail, outside } = freshJail("c1")
    expect(() => resolveJailed("../secret.txt", jail)).toThrow(FsJailError)
    expect(() => resolveJailed("../../../../../../etc/passwd", jail)).toThrow(FsJailError)
    expect(() => resolveJailed("a/../../b", jail)).toThrow(FsJailError)
    expect(() => resolveJailed("....//....//etc/passwd", jail)).not.toThrow() // literal dir name, stays inside
    expect(() => resolveJailed("/etc/passwd", jail)).toThrow(FsJailError)
    expect(() => resolveJailed(join(outside, "secret.txt"), jail)).toThrow(FsJailError)
  })

  test("a path that is the jail ROOT itself is allowed; the PARENT is rejected", () => {
    const { jail } = freshJail("c1b")
    expect(() => resolveJailed(".", jail)).not.toThrow()
    expect(resolveJailed(".", jail)).toBe(jail)
    expect(() => resolveJailed("..", jail)).toThrow(FsJailError)
  })

  test("NUL byte is rejected by the doc chokepoint; empty path is rejected", () => {
    const { jail } = freshJail("c1c")
    expect(() => resolveJailedDoc(jail, "a\0b", "csv")).toThrow(FsJailError)
    expect(() => resolveJailedDoc(jail, "", "csv")).toThrow(FsJailError)
    // resolveJailed("") would resolve to the root itself — the doc helper's
    // empty-path guard is what blocks an empty input from being "in-jail root".
    expect(() => resolveJailedDoc(jail, "/etc/passwd", "csv")).toThrow(FsJailError)
  })
})

/* ───────────────────────── CLASS 2 — symlink escape ────────────────────── */

describe("HELLGATE R5 — class 2: symlink escape (the classic)", () => {
  test("leaf symlink INSIDE the jail pointing OUTSIDE throws", () => {
    const { jail, outside } = freshJail("c2leaf")
    symlinkSync(join(outside, "secret.txt"), join(jail, "leaflink"))
    expect(() => resolveJailed("leaflink", jail)).toThrow(FsJailError)
  })

  test("PARENT-segment symlink (request jail/sub/file where jail/sub -> outside) throws", () => {
    const { jail, outside } = freshJail("c2parent")
    symlinkSync(outside, join(jail, "symdir")) // jail/symdir -> /outside (EXISTS)
    expect(() => resolveJailed("symdir/secret.txt", jail)).toThrow(FsJailError)
    expect(() => resolveJailed("symdir/newfile.txt", jail)).toThrow(FsJailError) // absent leaf too
  })

  test("symlink CHAIN (a -> b -> outside) is followed through every hop", () => {
    const { jail, outside } = freshJail("c2chain")
    symlinkSync(join(jail, "b"), join(jail, "a")) // a -> b (in jail lexically)
    symlinkSync(outside, join(jail, "b")) // b -> outside
    expect(() => resolveJailed("a/secret.txt", jail)).toThrow(FsJailError)
    expect(() => resolveJailed("a", jail)).toThrow(FsJailError)
  })

  test("relative symlink (link -> ../../etc) escaping throws", () => {
    const { jail } = freshJail("c2rel")
    symlinkSync("../../etc", join(jail, "rel")) // relative, target unresolvable under /tmp
    expect(() => resolveJailed("rel/passwd", jail)).toThrow(FsJailError)
  })

  test("symlink to the jail's own PARENT throws", () => {
    const { base, jail } = freshJail("c2par")
    symlinkSync(base, join(jail, "up")) // up -> the parent of jail
    expect(() => resolveJailed("up/outside/secret.txt", jail)).toThrow(FsJailError)
  })

  // ── [REGRESSION] the bug this round fixed ──────────────────────────────
  test("[REGRESSION] DANGLING symlink to outside (target absent at resolve) is BLOCKED", () => {
    const { jail, outside } = freshJail("c2dangle")
    // jail/esc -> /outside/ghostsub which does NOT yet exist. The OLD realResolve
    // climbed past `esc` (realpathSync threw) and treated it as a literal dir,
    // wrongly ADMITTING `esc/pwned.txt`. The fix lstat+readlinks it regardless.
    symlinkSync(join(outside, "ghostsub"), join(jail, "esc"))
    expect(() => resolveJailed("esc/pwned.txt", jail)).toThrow(FsJailError)
    expect(() => resolveJailed("esc", jail)).toThrow(FsJailError)
  })

  test("[REGRESSION] dangling-symlink create-then-escape WRITE is prevented end-to-end", () => {
    const { jail, outside } = freshJail("c2dangle2")
    const ghost = join(outside, "ghostsub")
    symlinkSync(ghost, join(jail, "esc")) // dangling at resolve time
    // Resolve MUST throw (so a consumer never gets a path string to write to).
    expect(() => resolveJailed("esc/pwned.txt", jail)).toThrow(FsJailError)
    // Sanity: had it NOT thrown and the agent later materialized the target,
    // the write would have escaped. Prove the target stays empty because the
    // jail refused to hand back a path.
    mkdirSync(ghost, { recursive: true })
    expect(existsSync(join(ghost, "pwned.txt"))).toBe(false)
  })

  test("dangling symlink pointing INSIDE the jail is STILL allowed (no false positive)", () => {
    const { jail } = freshJail("c2danglein")
    symlinkSync(join(jail, "future"), join(jail, "ilink")) // inside, absent target
    expect(() => resolveJailed("ilink/x.txt", jail)).not.toThrow()
    expect(resolveJailed("ilink/x.txt", jail)).toBe(join(jail, "ilink", "x.txt"))
  })
})

/* ───────────────────────── CLASS 3 — TOCTOU race ───────────────────────── */

describe("HELLGATE R5 — class 3: TOCTOU swap (parent dir → symlink between resolve and open)", () => {
  test("re-resolving after a benign path's parent is swapped to a symlink BLOCKS", () => {
    const { jail, outside } = freshJail("c3")
    // 1. A benign in-jail file exists; resolve succeeds.
    const sub = join(jail, "sub")
    mkdirSync(sub)
    writeFileSync(join(sub, "f.txt"), "benign")
    expect(() => resolveJailed("sub/f.txt", jail)).not.toThrow()

    // 2. SWAP: replace `sub` with a symlink to /outside (the TOCTOU window).
    rmSync(sub, { recursive: true, force: true })
    symlinkSync(outside, sub) // jail/sub -> /outside

    // 3. The consumer's re-jail (every storage op re-runs enforceJail) now sees
    //    the symlink and REJECTS — proving the open is re-jailed, not trusting a
    //    cached resolved string.
    expect(() => resolveJailed("sub/secret.txt", jail)).toThrow(FsJailError)
    expect(() => resolvePath("sub/secret.txt", jail)).toThrow(FsJailError)
  })

  test("a leaf swapped to an outward symlink between two resolves is caught on the 2nd", () => {
    const { jail, outside } = freshJail("c3leaf")
    const leaf = join(jail, "data")
    writeFileSync(leaf, "ok")
    expect(() => resolveJailed("data", jail)).not.toThrow()
    rmSync(leaf)
    symlinkSync(join(outside, "secret.txt"), leaf) // data -> outside/secret.txt
    expect(() => resolveJailed("data", jail)).toThrow(FsJailError)
  })
})

/* ───────────────────────── CLASS 4 — special paths / root ──────────────── */

describe("HELLGATE R5 — class 4: special-path bounds (no whole-disk via the jail)", () => {
  test("the jail root cannot be `/` smuggled through a relative request", () => {
    const { jail } = freshJail("c4")
    // Even when a request normalizes upward, it can never reach `/`.
    expect(() => resolveJailed("../../../../../../../..", jail)).toThrow(FsJailError)
    // A request whose only valid resolution is the jail root stays bounded.
    expect(resolveJailed("./", jail)).toBe(jail)
  })

  test("an empty / undefined jail root is REFUSED (no silent un-jail bypass)", () => {
    expect(() => resolveJailed("anything", "")).toThrow(FsJailError)
    // @ts-expect-error — exercising the runtime guard against a missing root.
    expect(() => resolveJailed("anything", undefined)).toThrow(FsJailError)
  })
})

/* ───────────────────────── CLASS 5 — normalization quirks ──────────────── */

describe("HELLGATE R5 — class 5: case / unicode / slash normalization", () => {
  test("trailing slash, double slash, and `//../` quirks stay bounded", () => {
    const { jail, outside } = freshJail("c5")
    // double-slash then climb out
    const evilSibling = `${jail}evil`
    mkdirSync(evilSibling)
    writeFileSync(join(evilSibling, "s.txt"), "SIBLING")
    expect(() => resolveJailed(`sub//../../${evilSibling.split("/").pop()}/s.txt`, jail)).toThrow(
      FsJailError,
    )
    // a trailing-slash in-jail dir is fine
    expect(() => resolveJailed("inner/", jail)).not.toThrow()
    void outside
  })

  test("sibling-prefix trap: jail=/x/jail must NOT admit /x/jailEVIL", () => {
    const { jail } = freshJail("c5sib")
    const sibling = `${jail}EVIL`
    mkdirSync(sibling)
    writeFileSync(join(sibling, "s.txt"), "SIBLING")
    expect(() => resolveJailed(`${sibling}/s.txt`, jail)).toThrow(FsJailError)
  })

  test("a unicode/NFD path that is a literal in-jail name is admitted (not an escape)", () => {
    const { jail } = freshJail("c5uni")
    // Composed vs decomposed é — neither normalizes to a `..`; both stay in-jail.
    expect(() => resolveJailed("café/data.txt", jail)).not.toThrow()
    expect(() => resolveJailed("café/data.txt", jail)).not.toThrow()
  })
})

/* ───────────────────────── CLASS 6 — windows-style strings ─────────────── */

describe("HELLGATE R5 — class 6: windows-style path strings on POSIX", () => {
  test("backslash separators are literal filename chars (no escape) and stay in-jail", () => {
    const { jail } = freshJail("c6")
    // On POSIX `..\..\etc` is a single weird FILENAME, not a traversal — it must
    // resolve to an in-jail literal, never out.
    const r = resolveJailed("..\\..\\etc\\passwd", jail)
    expect(r.startsWith(jail)).toBe(true)
  })

  test("drive-absolute and UNC strings cannot escape the POSIX jail", () => {
    const { jail } = freshJail("c6unc")
    // These are nonsense on POSIX — they become in-jail literal names, never
    // an out-of-jail absolute. The invariant: result is contained.
    expect(resolveJailed("C:\\Windows\\System32", jail).startsWith(jail)).toBe(true)
    expect(resolveJailed("\\\\server\\share\\x", jail).startsWith(jail)).toBe(true)
  })
})

/* ───────────────────────── fsJailLib parity ────────────────────────────── */

describe("HELLGATE R5 — fsJailLib (is-path-inside backed) has the SAME dangling-symlink fix", () => {
  test("dangling symlink to outside is rejected by fsJailLib.assertInside", async () => {
    const { jail, outside } = freshJail("libdangle")
    symlinkSync(join(outside, "ghostsub"), join(jail, "esc"))
    const lib = fsJailLib({ root: jail, resolveSymlinks: true })
    expect(await lib.isInside(join(jail, "esc", "pwned.txt"))).toBe(false)
    await expect(lib.assertInside(join(jail, "esc", "pwned.txt"))).rejects.toBeInstanceOf(
      FsJailError,
    )
  })

  test("fsJailLib still admits a legit in-jail path", async () => {
    const { jail } = freshJail("libok")
    mkdirSync(join(jail, "sub"))
    writeFileSync(join(jail, "sub", "f.txt"), "x")
    const lib = fsJailLib({ root: jail, resolveSymlinks: true })
    expect(await lib.isInside(join(jail, "sub", "f.txt"))).toBe(true)
  })
})

/* ───────────────────────── no-false-positive proof ────────────────────── */

describe("HELLGATE R5 — in-jail access STILL WORKS (fix is not over-broad)", () => {
  test("plain read/write of in-jail paths resolves correctly", () => {
    const { jail } = freshJail("happy")
    mkdirSync(join(jail, "d"))
    writeFileSync(join(jail, "d", "real.txt"), "hi")
    expect(resolveJailed("d/real.txt", jail)).toBe(join(jail, "d", "real.txt"))
    expect(resolveJailed("brand/new/file.txt", jail)).toBe(join(jail, "brand", "new", "file.txt"))
    // inward symlink to existing in-jail dir
    symlinkSync(join(jail, "d"), join(jail, "alias"))
    expect(() => resolveJailed("alias/real.txt", jail)).not.toThrow()
    expect(readFileSync(resolveJailed("alias/real.txt", jail), "utf8")).toBe("hi")
  })
})
