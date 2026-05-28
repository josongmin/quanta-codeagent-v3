/**
 * ADR-0413 — File resolver (sync) hellgate.
 *
 *   A. Hit ⇒ bodyText = file content                 (2)
 *   B. Miss / dir / unreadable ⇒ null                 (3)
 *   C. fs-jail: path outside root ⇒ null              (3)
 *   D. Binary (NUL byte) ⇒ null                       (1)
 *   E. Over-cap ⇒ truncated (not null)                (1)
 *   F. NO-THROW + empty / hostile target ⇒ null       (2)
 *
 * Total = 12 cases (>= the required 8). Uses a real tmp workspace so
 * the sync fs-jail + readFileSync path is exercised end-to-end.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createFileResolver } from "../file-resolver"

let root: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "quanta-file-mention-root-"))
  outside = mkdtempSync(join(tmpdir(), "quanta-file-mention-outside-"))

  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "hello.ts"), "export const hi = 1\n", "utf8")
  writeFileSync(join(root, "README.md"), "# Title\nbody line\n", "utf8")
  mkdirSync(join(root, "emptydir"), { recursive: true })

  // binary: a NUL byte inside the sniff window
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x41, 0x00, 0x42, 0x43]))

  // over-cap: > 256 KiB
  writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024), "utf8")

  // outside file + a symlink from inside root pointing out
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n", "utf8")
  try {
    symlinkSync(join(outside, "secret.txt"), join(root, "escape-link"))
  } catch {
    /* symlink may be unsupported in some CI; the test for it is skipped below */
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe("createFileResolver — ADR-0413 hellgate", () => {
  // -------- A. hit --------------------------------------------------

  test("A1 — relative path hit ⇒ bodyText is the file content", () => {
    const resolve = createFileResolver({ root })
    expect(resolve("src/hello.ts")).toEqual({ bodyText: "export const hi = 1\n" })
  })

  test("A2 — top-level file hit", () => {
    const resolve = createFileResolver({ root })
    expect(resolve("README.md")).toEqual({ bodyText: "# Title\nbody line\n" })
  })

  // -------- B. miss / dir / unreadable ------------------------------

  test("B1 — missing file ⇒ null", () => {
    const resolve = createFileResolver({ root })
    expect(resolve("src/does-not-exist.ts")).toBeNull()
  })

  test("B2 — directory target ⇒ null (not a readable file)", () => {
    const resolve = createFileResolver({ root })
    expect(resolve("emptydir")).toBeNull()
  })

  test("B3 — no root configured ⇒ null", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile partial opts
    const resolve = createFileResolver({} as any)
    expect(resolve("README.md")).toBeNull()
  })

  // -------- C. fs-jail ----------------------------------------------

  test("C1 — absolute path outside root ⇒ null", () => {
    const resolve = createFileResolver({ root })
    expect(resolve(join(outside, "secret.txt"))).toBeNull()
  })

  test("C2 — ../ traversal escaping root ⇒ null", () => {
    const resolve = createFileResolver({ root })
    expect(resolve("../../etc/passwd")).toBeNull()
  })

  test("C3 — symlink inside root pointing outside ⇒ null (resolveSymlinks)", () => {
    const resolve = createFileResolver({ root })
    // If symlink creation failed at setup the file simply won't exist ⇒ null too.
    expect(resolve("escape-link")).toBeNull()
  })

  // -------- D. binary -----------------------------------------------

  test("D1 — file with NUL byte in sniff window ⇒ null (binary skip)", () => {
    const resolve = createFileResolver({ root })
    expect(resolve("bin.dat")).toBeNull()
  })

  // -------- E. over-cap ---------------------------------------------

  test("E1 — over-cap file ⇒ truncated body with notice (NOT null)", () => {
    const resolve = createFileResolver({ root })
    const res = resolve("big.txt")
    expect(res).not.toBeNull()
    expect(res?.bodyText.length).toBeLessThan(300 * 1024)
    expect(res?.bodyText).toContain("truncated")
  })

  // -------- F. no-throw / hostile target ----------------------------

  test("F1 — empty target ⇒ null", () => {
    const resolve = createFileResolver({ root })
    expect(resolve("")).toBeNull()
  })

  test("F2 — non-string target (hostile cast) ⇒ null, no throw", () => {
    const resolve = createFileResolver({ root })
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile cast for NO-THROW invariant
    expect(resolve(null as any)).toBeNull()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile cast for NO-THROW invariant
    expect(resolve(undefined as any)).toBeNull()
  })
})
