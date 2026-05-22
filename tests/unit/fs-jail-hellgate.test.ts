/**
 * HELLGATE — fs-jail traversal attacks (B10).
 *
 * Security invariant under attack: NO path manipulation can read or write
 * outside the working-directory jail root. The jail resolves the FULL realpath
 * chain (not just one symlink hop), rejects relative `..` climbs and absolute
 * outside paths, and the QUANTA_FS_JAIL=off opt-out is the ONLY documented
 * bypass. Symlinks that stay inside the jail, and paths that lexically climb
 * but normalize back inside, are NOT false-positived.
 *
 * Source under test: src/storage/service.ts (resolvePath / enforceJail /
 * realResolve). Env (QUANTA_FS_JAIL) is set/restored carefully per-test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { FsJailError, resolvePath } from "@/storage"

// Jail root + an outside dir that holds a "secret".
const jail = mkdtempSync(join(tmpdir(), "fs-jail-hell-"))
const outside = mkdtempSync(join(tmpdir(), "fs-jail-hell-out-"))
writeFileSync(join(outside, "secret.txt"), "TOP-SECRET")

// ── Nested symlink CHAIN: jail/a -> jail/b -> outside ──────────────────────
// `a` points at `b` (inside the jail); `b` points at the OUTSIDE dir. A naive
// one-hop resolver that only de-references `a` would land on `b` (still inside)
// and wrongly allow it. The jail must follow the WHOLE chain to `outside`.
symlinkSync(join(jail, "b"), join(jail, "a")) // a -> b   (both in jail lexically)
symlinkSync(outside, join(jail, "b")) // b -> outside

// A symlink whose target is INSIDE the jail (must NOT be a false positive).
mkdirSync(join(jail, "real-sub"), { recursive: true })
writeFileSync(join(jail, "real-sub", "in.txt"), "inside content")
symlinkSync(join(jail, "real-sub"), join(jail, "inward-link")) // inward-link -> real-sub

afterAll(() => {
  rmSync(jail, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env.QUANTA_FS_JAIL
  __resetRuntimeConfig()
})
afterEach(() => {
  delete process.env.QUANTA_FS_JAIL
  __resetRuntimeConfig()
})

describe("HELLGATE B10 — symlink CHAIN escape is resolved through every hop", () => {
  test("jail/a -> jail/b -> outside : reading through the chain throws FsJailError", () => {
    // a/secret.txt resolves a->b->outside/secret.txt — fully outside the jail.
    expect(() => resolvePath("a/secret.txt", jail)).toThrow(FsJailError)
  })

  test("the intermediate hop alone (jail/b) also resolves outside ⇒ throws", () => {
    expect(() => resolvePath("b/secret.txt", jail)).toThrow(FsJailError)
  })

  test("dereferencing the chain to the bare escape dir throws too", () => {
    expect(() => resolvePath("a", jail)).toThrow(FsJailError)
  })
})

describe("HELLGATE B10 — relative + absolute traversal", () => {
  test("`../../../etc/passwd` relative climb out of the jail throws FsJailError", () => {
    expect(() => resolvePath("../../../etc/passwd", jail)).toThrow(FsJailError)
  })

  test("an absolute path outside the jail throws FsJailError", () => {
    expect(() => resolvePath(join(outside, "secret.txt"), jail)).toThrow(FsJailError)
    expect(() => resolvePath("/etc/passwd", jail)).toThrow(FsJailError)
  })

  test("a deeply nested `..` sequence that still escapes throws", () => {
    expect(() => resolvePath("real-sub/../../../../../tmp", jail)).toThrow(FsJailError)
  })
})

describe("HELLGATE B10 — NO false positives (legit in-jail paths allowed)", () => {
  test("a symlink whose target is INSIDE the jail is allowed (no throw)", () => {
    // inward-link -> real-sub (both inside the jail). The realpath chain stays
    // inside the root, so enforceJail passes. resolvePath returns the LEXICAL
    // absolute path (the realpath is used only for the boundary check), so the
    // invariant we assert is: it is admitted (no FsJailError) and resolves
    // against the jail root.
    expect(() => resolvePath("inward-link/in.txt", jail)).not.toThrow()
    expect(resolvePath("inward-link/in.txt", jail)).toBe(join(jail, "inward-link", "in.txt"))
  })

  test("`jail/sub/../legit.txt` normalizes back inside ⇒ allowed", () => {
    // Lexically climbs one level then descends — net path stays in the jail.
    expect(() => resolvePath("real-sub/../legit.txt", jail)).not.toThrow()
    expect(resolvePath("real-sub/../legit.txt", jail)).toBe(join(jail, "legit.txt"))
  })

  test("a plain in-jail relative path is allowed and resolved against the root", () => {
    expect(resolvePath("real-sub/in.txt", jail)).toBe(join(jail, "real-sub", "in.txt"))
  })
})

describe("HELLGATE B10 — QUANTA_FS_JAIL=off opt-out boundary (set/restore carefully)", () => {
  test("the SAME chain escape that throws when ON does NOT throw when off", () => {
    // Control: jail ON ⇒ escape throws.
    expect(() => resolvePath("a/secret.txt", jail)).toThrow(FsJailError)

    // Opt-out: jail OFF ⇒ the identical escape is permitted (returns a path,
    // no throw). runtimeConfig reads the env once, so reset is required.
    process.env.QUANTA_FS_JAIL = "off"
    __resetRuntimeConfig()
    expect(() => resolvePath("a/secret.txt", jail)).not.toThrow()
    expect(() => resolvePath("../../../etc/passwd", jail)).not.toThrow()
    expect(resolvePath("/etc/passwd", jail)).toBe("/etc/passwd")

    // Restore: turning the jail back ON re-throws (proves opt-out is not sticky).
    delete process.env.QUANTA_FS_JAIL
    __resetRuntimeConfig()
    expect(() => resolvePath("a/secret.txt", jail)).toThrow(FsJailError)
  })
})
