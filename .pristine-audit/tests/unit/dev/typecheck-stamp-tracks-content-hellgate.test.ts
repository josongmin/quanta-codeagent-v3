import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fingerprintOf, hashTrackedFile } from "../../../tools/dev/typecheck"

// HELLGATE — RCA jun-08: ~300 test tsc errors accumulated invisibly because the
// stamp cache decided skip-vs-run from an mtime+size proxy. mtime+size is an
// UNSOUND change detector: a content change that preserves the byte size while
// the mtime is reset to an older/identical value (git checkout / stash pop /
// rsync --times / mtime-preserving editors) yields an identical fingerprint, so
// the stamp falsely reports "unchanged" and tsc is skipped, masking the new
// type errors.
//
// These tests exercise the REAL production hashing functions (hashTrackedFile /
// fingerprintOf) against a temp dir. red-on-injection: if hashTrackedFile ever
// reverts to a size/mtime proxy that ignores content, the mutation cases below
// will produce an unchanged fingerprint and fail.

const buildFingerprintFor = async (baseDir: string, files: readonly string[]): Promise<string> => {
  const entries = (
    await Promise.all([...files].sort().map((f) => hashTrackedFile(f, baseDir)))
  ).filter((e): e is { path: string; hash: string } => e !== null)
  return fingerprintOf(entries)
}

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "typecheck-stamp-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("typecheck stamp tracks file content (hellgate)", () => {
  test("same-size, same-mtime content change INVALIDATES the fingerprint", async () => {
    await withTempDir(async (dir) => {
      const abs = join(dir, "example.test.ts")
      await writeFile(abs, "const ok: string = 'aaaa'\n")
      // pin an old mtime — simulates git checkout / mtime-preserving restore
      const pinned = new Date("2026-01-01T00:00:00Z")
      await utimes(abs, pinned, pinned)

      const before = await buildFingerprintFor(dir, ["example.test.ts"])

      // Replace with DIFFERENT content of the SAME byte length (introduces a
      // would-be type error: number assigned to string). Re-pin the same mtime.
      const original = "const ok: string = 'aaaa'\n"
      const mutated = "const ok: string = 12345\n\n" // same byte length
      expect(Buffer.byteLength(mutated)).toBe(Buffer.byteLength(original))
      await writeFile(abs, mutated)
      await utimes(abs, pinned, pinned)

      const after = await buildFingerprintFor(dir, ["example.test.ts"])

      // If the stamp ignored content (size+mtime proxy) these would be equal and
      // the typecheck would be wrongly skipped, masking the injected error.
      expect(after).not.toBe(before)
    })
  })

  test("byte-identical content keeps the fingerprint stable (cache perf preserved)", async () => {
    await withTempDir(async (dir) => {
      const abs = join(dir, "a.ts")
      await writeFile(abs, "export const x = 1\n")
      const first = await buildFingerprintFor(dir, ["a.ts"])

      // Rewrite identical bytes with a NEWER mtime — content unchanged.
      await writeFile(abs, "export const x = 1\n")
      const newer = new Date(Date.now() + 60_000)
      await utimes(abs, newer, newer)
      const second = await buildFingerprintFor(dir, ["a.ts"])

      expect(second).toBe(first)
    })
  })

  test("any byte change invalidates the fingerprint", async () => {
    await withTempDir(async (dir) => {
      const abs = join(dir, "b.ts")
      await writeFile(abs, "export const y = 1\n")
      const before = await buildFingerprintFor(dir, ["b.ts"])
      await writeFile(abs, "export const y = 2\n")
      const after = await buildFingerprintFor(dir, ["b.ts"])
      expect(after).not.toBe(before)
    })
  })

  test("hashTrackedFile returns null for missing files (skip-safe)", async () => {
    await withTempDir(async (dir) => {
      const entry = await hashTrackedFile("does-not-exist.ts", dir)
      expect(entry).toBeNull()
    })
  })

  test("fingerprint is order-independent of input file ordering", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "one.ts"), "export const a = 1\n")
      await writeFile(join(dir, "two.ts"), "export const b = 2\n")
      const ab = await buildFingerprintFor(dir, ["one.ts", "two.ts"])
      const ba = await buildFingerprintFor(dir, ["two.ts", "one.ts"])
      expect(ab).toBe(ba)
    })
  })
})
