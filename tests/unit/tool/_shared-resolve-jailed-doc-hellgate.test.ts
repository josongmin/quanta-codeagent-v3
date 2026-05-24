/**
 * Hellgate — `resolveJailedDoc` (Slice S7).
 *
 * The helper is the unified FS-jail chokepoint every document & image reader
 * threads through after Slice S7. This battery seals the contract so a
 * future tool author cannot drift it back into the per-tool-resolveXxxPath
 * fragmentation that S7 closed.
 *
 * Seal:
 *   A. Behavior matches `resolveJailed` for valid paths under cwd
 *   B. FsJailError bubbles for every documented violation
 *   C. The returned value is a plain `string` (brand-stripped for downstream
 *      string-typed APIs); the safety lives in the throw, not in the type
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FsJailError, resolveJailed } from "@/storage"
import { resolveJailedDoc } from "@/tool/_shared/resolve-jailed-doc"

let workDir = ""

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "resolve-jailed-doc-hell-"))
  // NOTE: macOS tmp is /var → /private/var symlink. `resolveJailed`
  // lexically resolves the request against the (possibly-symlinked) jail
  // root and returns the lexical absolute string — it does NOT rewrite
  // the returned path to its realpath (realpath is only consulted INSIDE
  // `enforceJail` for the containment check). Assertions therefore
  // compare to `path.resolve(workDir, ...)`, not `realpathSync(workDir)`.
  await writeFile(path.join(workDir, "file.txt"), "hi\n")
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

describe("A. behavior matches resolveJailed for valid paths", () => {
  test("1. relative path under cwd → equals resolveJailed output (string-equal)", () => {
    const a = resolveJailedDoc(workDir, "file.txt", "csv")
    const b = resolveJailed("file.txt", workDir) as string
    expect(a).toBe(b)
    expect(a).toBe(path.resolve(workDir, "file.txt"))
  })

  test("2. absolute path under cwd → resolves to the same absolute string", () => {
    const abs = path.join(workDir, "file.txt")
    const a = resolveJailedDoc(workDir, abs, "yaml")
    expect(a).toBe(path.resolve(workDir, "file.txt"))
  })

  test("3. nested relative path under cwd → resolves through cwd", () => {
    const a = resolveJailedDoc(workDir, "sub/nested.txt", "ndjson")
    expect(a).toBe(path.resolve(workDir, "sub", "nested.txt"))
  })

  test("4. cwd itself ('.') → resolves to cwd (lexical, not realpathed)", () => {
    const a = resolveJailedDoc(workDir, ".", "pdf")
    expect(a).toBe(path.resolve(workDir))
  })

  test("5. returned value is a plain string (typeof === 'string')", () => {
    const a = resolveJailedDoc(workDir, "file.txt", "image")
    // The brand is a TYPE-level marker only; runtime is a string. This
    // assertion documents the seam — downstream Bun.file / lstat accept
    // string, so the unwrap is intentional and load-bearing.
    expect(typeof a).toBe("string")
  })
})

describe("B. FsJailError bubbles for every documented violation", () => {
  test("6. empty string → FsJailError with kind in message", () => {
    expect(() => resolveJailedDoc(workDir, "", "csv")).toThrow(FsJailError)
    try {
      resolveJailedDoc(workDir, "", "csv")
    } catch (e) {
      expect(e).toBeInstanceOf(FsJailError)
      expect((e as Error).message).toContain("csv")
      expect((e as Error).message).toContain("empty path")
    }
  })

  test("7. NUL byte anywhere in path → FsJailError", () => {
    expect(() => resolveJailedDoc(workDir, "foo\0bar", "yaml")).toThrow(FsJailError)
    try {
      resolveJailedDoc(workDir, "a\0b", "yaml")
    } catch (e) {
      expect(e).toBeInstanceOf(FsJailError)
      expect((e as Error).message).toContain("yaml")
      expect((e as Error).message).toContain("NUL")
    }
  })

  test("8. `..` traversal that escapes cwd → FsJailError (delegated to resolveJailed)", () => {
    // The escape depth is enough to leave any tmpdir hierarchy.
    expect(() => resolveJailedDoc(workDir, "../../../../../etc/passwd", "image")).toThrow(
      FsJailError,
    )
  })

  test("9. absolute path outside cwd → FsJailError", () => {
    expect(() => resolveJailedDoc(workDir, "/etc/passwd", "csv")).toThrow(FsJailError)
  })

  test("10. sibling-prefix trap (`/jailX` not allowed for `/jail` cwd) → FsJailError", async () => {
    // Build two sibling dirs whose names share a string prefix. The naive
    // `startsWith(cwd)` check (without segment-boundary guard) would let
    // `/jail-buddy/secret` pass for cwd `/jail`. The canonical jail uses
    // segment-boundary `isInside` so this is a clean reject.
    const jail = await mkdtemp(path.join(tmpdir(), "jail-"))
    const sibling = `${jail}-buddy`
    await writeFile(`${jail}/in.txt`, "ok\n")
    try {
      await writeFile(`${sibling}/secret.txt`, "leak\n")
    } catch {
      // Sibling may not exist on the filesystem yet — that's fine; jail
      // enforcement is lexical-first, then realpath of the existing parent.
      // We still expect the throw because the sibling target is outside
      // the realpath-resolved jail.
    }
    try {
      expect(() => resolveJailedDoc(jail, `${sibling}/secret.txt`, "csv")).toThrow(FsJailError)
    } finally {
      await rm(jail, { recursive: true, force: true })
      await rm(sibling, { recursive: true, force: true })
    }
  })

  test("11. symlinked parent that escapes jail → FsJailError (realpath resolved)", async () => {
    // Create a jail with a `link` symlink that points OUTSIDE the jail.
    // The naive lexical-only check would happily accept `link/foo.txt`
    // because the lexical path stays under cwd; the canonical jail
    // realpaths the existing parent and catches the escape.
    const jail = await mkdtemp(path.join(tmpdir(), "jail-sym-"))
    const outside = await mkdtemp(path.join(tmpdir(), "outside-"))
    try {
      await writeFile(path.join(outside, "secret.txt"), "leak\n")
      await symlink(outside, path.join(jail, "link"))
      expect(() => resolveJailedDoc(jail, "link/secret.txt", "image")).toThrow(FsJailError)
    } finally {
      await rm(jail, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("12. empty cwd jail-root rejected (cannot meaningfully jail)", () => {
    // `resolveJailed` raises on empty/missing jailRoot to close the prior
    // silent-bypass surface. The doc helper passes through unchanged.
    expect(() => resolveJailedDoc("", "file.txt", "csv")).toThrow(FsJailError)
  })
})

describe("C. plain-string return is the seam", () => {
  test("13. result feeds string-typed downstream APIs (lstat-shape happy)", async () => {
    // We don't actually call lstat here — we assert the value has the shape
    // string-typed Node APIs accept (string, non-empty, absolute). The
    // hellgate's job is to seal the contract; the real consumers
    // (csv_read, pdf_read, …) exercise the call path in their own
    // batteries.
    const a = resolveJailedDoc(workDir, "file.txt", "csv")
    expect(typeof a).toBe("string")
    expect(a.length).toBeGreaterThan(0)
    expect(path.isAbsolute(a)).toBe(true)
  })

  test("14. kind label appears in the empty-path error (triage hint)", () => {
    // The `kind` argument is the only per-tool signal in the error message;
    // tail-log triage greps it to attribute a violation to a specific reader.
    try {
      resolveJailedDoc(workDir, "", "ndjson")
    } catch (e) {
      expect((e as Error).message).toMatch(/^ndjson:/)
    }
  })

  test("15. kind label appears in the NUL-byte error (triage hint)", () => {
    try {
      resolveJailedDoc(workDir, "x\0y", "pdf")
    } catch (e) {
      expect((e as Error).message).toMatch(/^pdf:/)
    }
  })
})
