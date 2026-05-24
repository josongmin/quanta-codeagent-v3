/**
 * ★ CONTRACT — ADR-0192: src/storage/fs-jail-lib.ts is the SIBLING adapter
 *   that delegates the segment-boundary containment check to `is-path-inside@4`
 *   (Sindre Sorhus). MUST behave like service.ts's self-impl on the security
 *   invariant: no path manipulation lands `assertInside` outside `root`.
 *   Symlinks pointing OUTSIDE the jail are rejected when `resolveSymlinks` is
 *   on. The existing service.ts fs-jail is NOT modified — its hellgate stays
 *   green (verified separately).
 *
 * HELLGATE — fs-jail-lib (is-path-inside adapter).
 *
 * Security invariant under attack: the new adapter MUST refuse the same
 * escape vectors the existing service.ts adapter refuses (segment-boundary
 * trick `/rootfoo` vs `/root`; relative climb `../escape`; symlink chain
 * jail/a → outside). Lexical-only mode (`resolveSymlinks: false`) is the
 * documented opt-out for callers that know they hold a non-symlink target.
 */

import { describe, expect, mock, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { FsJailError, fsJailLib } from "@/storage/fs-jail-lib"

// ── A. Containment basic (6) ────────────────────────────────────────────────
describe("HELLGATE 0192-A — segment-boundary containment basic", () => {
  test("A1: /root/a/b is inside /root → isInside true", async () => {
    const jail = fsJailLib({ root: "/root", resolveSymlinks: false })
    expect(await jail.isInside("/root/a/b")).toBe(true)
  })

  test("A2: /root is NOT inside /root (lib treats path-equal-to-root as NOT inside)", async () => {
    // Documented lib semantics: isPathInside('a/b/c', 'a/b/c') === false.
    // Mirrors `path.relative("/root", "/root") === ""`. Callers that want
    // "inside or equal" must check equality separately.
    const jail = fsJailLib({ root: "/root", resolveSymlinks: false })
    expect(await jail.isInside("/root")).toBe(false)
  })

  test("A3: /other/a is outside /root → false", async () => {
    const jail = fsJailLib({ root: "/root", resolveSymlinks: false })
    expect(await jail.isInside("/other/a")).toBe(false)
  })

  test("A4: /rootfoo is NOT inside /root (segment-boundary check — the whole point)", async () => {
    // A naive `startsWith("/root")` check would falsely admit /rootfoo. The
    // lib's `path.relative` produces "../rootfoo" here ⇒ correctly false.
    const jail = fsJailLib({ root: "/root", resolveSymlinks: false })
    expect(await jail.isInside("/rootfoo")).toBe(false)
    expect(await jail.isInside("/rootfoo/secret.txt")).toBe(false)
  })

  test("A5: /root/a/../b resolves lexically to /root/b → inside", async () => {
    const jail = fsJailLib({ root: "/root", resolveSymlinks: false })
    expect(await jail.isInside("/root/a/../b")).toBe(true)
  })

  test("A6: /root/../escape resolves to /escape → false", async () => {
    const jail = fsJailLib({ root: "/root", resolveSymlinks: false })
    expect(await jail.isInside("/root/../escape")).toBe(false)
  })
})

// ── B. Symlink (3) — uses tmpdir for real filesystem inodes ──────────────────
// Note: on macOS `/var/folders/...` is itself a symlink to `/private/var/...`,
// so realpath of any tmpdir path differs from its lexical form. We realpath
// BOTH the jail root and the outside root at setup time so the
// `resolveSymlinks: true` path compares like-for-like (canonical vs canonical).
const jailRoot = realpathSync(mkdtempSync(join(tmpdir(), "fs-jail-lib-B-")))
const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "fs-jail-lib-B-out-")))

mkdirSync(join(jailRoot, "real-sub"), { recursive: true })
writeFileSync(join(jailRoot, "real-sub", "in.txt"), "inside")
writeFileSync(join(outsideRoot, "secret.txt"), "TOP-SECRET")
symlinkSync(join(jailRoot, "real-sub"), join(jailRoot, "inward"))
symlinkSync(outsideRoot, join(jailRoot, "outward"))

describe("HELLGATE 0192-B — symlink resolution behavior", () => {
  test("B7: inward symlink (in-jail → in-jail) → isInside true", async () => {
    const jail = fsJailLib({ root: jailRoot, resolveSymlinks: true })
    // realpath of jailRoot/inward/in.txt → jailRoot/real-sub/in.txt → INSIDE.
    expect(await jail.isInside(join(jailRoot, "inward", "in.txt"))).toBe(true)
  })

  test("B8: outward symlink (in-jail → OUTSIDE) → isInside false (realpath escapes)", async () => {
    const jail = fsJailLib({ root: jailRoot, resolveSymlinks: true })
    // realpath of jailRoot/outward/secret.txt → outsideRoot/secret.txt
    // → outside the jail. The lib's segment-boundary check rejects it.
    expect(await jail.isInside(join(jailRoot, "outward", "secret.txt"))).toBe(false)
  })

  test("B9: resolveSymlinks=false → lexical only; outward symlink is admitted (target ignored)", async () => {
    const jail = fsJailLib({ root: jailRoot, resolveSymlinks: false })
    // Lexically jailRoot/outward/secret.txt IS under jailRoot/. The lib only
    // checks segment boundaries — it does NOT dereference symlinks. This is
    // the documented `resolveSymlinks: false` posture: faster, but ONLY safe
    // when the caller knows the path has no symlinks. Caller's responsibility.
    expect(await jail.isInside(join(jailRoot, "outward", "secret.txt"))).toBe(true)
  })

  // Cleanup
  test("B-cleanup: rmtree tmpdirs", () => {
    const cleanupSpy = mock((dir: string) => rmSync(dir, { recursive: true, force: true }))
    cleanupSpy(jailRoot)
    cleanupSpy(outsideRoot)
    expect(existsSync(jailRoot)).toBe(false)
    expect(existsSync(outsideRoot)).toBe(false)
    expect(cleanupSpy).toHaveBeenCalledTimes(2)
  })
})

// ── C. assertInside (3) ─────────────────────────────────────────────────────
describe("HELLGATE 0192-C — assertInside behavior", () => {
  test("C10: inside → returns the absolute path (lexical when resolveSymlinks=false)", async () => {
    const jail = fsJailLib({ root: "/root", resolveSymlinks: false })
    const out = await jail.assertInside("/root/a/b")
    expect(out).toBe("/root/a/b")
  })

  test("C11: outside → throws FsJailError with target + root fields populated", async () => {
    const jail = fsJailLib({ root: "/root", resolveSymlinks: false })
    let caught: unknown
    try {
      await jail.assertInside("/etc/passwd")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(FsJailError)
    const err = caught as FsJailError
    expect(err.target).toBe("/etc/passwd")
    expect(err.root).toBe("/root")
    expect(err.name).toBe("FsJailError")
    expect(err.message).toContain("/etc/passwd")
    expect(err.message).toContain("/root")
  })

  test("C12: relative target → resolved against process.cwd() before the check", async () => {
    // process.cwd() is the project root in this test runner. Pick a root that
    // IS the cwd, then a relative target → absTarget = path.resolve("./x") =
    // cwd/x → inside cwd ⇒ admitted.
    const jail = fsJailLib({ root: process.cwd(), resolveSymlinks: false })
    const out = await jail.assertInside("./some-file-inside.txt")
    expect(out).toBe(resolve(process.cwd(), "some-file-inside.txt"))

    // And the negative case: relative climb out of cwd ⇒ rejected.
    await expect(jail.assertInside("../../../etc/passwd")).rejects.toThrow(FsJailError)
  })
})
