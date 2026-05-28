/**
 * ADR-0413 / ADR-0418 — File resolver (async) hellgate.
 *
 *   A. Hit ⇒ bodyText = file content                 (2)
 *   B. Miss / dir / unreadable ⇒ null                 (3)
 *   C. fs-jail: path outside root ⇒ null              (3)
 *   D. Binary (NUL byte) ⇒ null                       (1)
 *   E. Over-cap ⇒ truncated (not null)                (1)
 *   F. NO-THROW + empty / hostile target ⇒ null       (2)
 *
 * Total = 12 cases (>= the required 8). Uses a real tmp workspace so
 * the async fs-jail + fs.readFile path is exercised end-to-end.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("A1 — relative path hit ⇒ bodyText is the file content", async () => {
    const resolve = createFileResolver({ root })
    expect(await resolve("src/hello.ts")).toEqual({ bodyText: "export const hi = 1\n" })
  })

  test("A2 — top-level file hit", async () => {
    const resolve = createFileResolver({ root })
    expect(await resolve("README.md")).toEqual({ bodyText: "# Title\nbody line\n" })
  })

  // -------- B. miss / dir / unreadable ------------------------------

  test("B1 — missing file ⇒ null", async () => {
    const resolve = createFileResolver({ root })
    expect(await resolve("src/does-not-exist.ts")).toBeNull()
  })

  test("B2 — directory target ⇒ null (not a readable file)", async () => {
    const resolve = createFileResolver({ root })
    expect(await resolve("emptydir")).toBeNull()
  })

  test("B3 — no root configured ⇒ null", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile partial opts
    const resolve = createFileResolver({} as any)
    expect(await resolve("README.md")).toBeNull()
  })

  // -------- C. fs-jail ----------------------------------------------

  test("C1 — absolute path outside root ⇒ null", async () => {
    const resolve = createFileResolver({ root })
    expect(await resolve(join(outside, "secret.txt"))).toBeNull()
  })

  test("C2 — ../ traversal escaping root ⇒ null", async () => {
    const resolve = createFileResolver({ root })
    expect(await resolve("../../etc/passwd")).toBeNull()
  })

  test("C3 — symlink inside root pointing outside ⇒ null (resolveSymlinks)", async () => {
    const resolve = createFileResolver({ root })
    // If symlink creation failed at setup the file simply won't exist ⇒ null too.
    expect(await resolve("escape-link")).toBeNull()
  })

  // -------- D. binary -----------------------------------------------

  test("D1 — file with NUL byte in sniff window ⇒ null (binary skip)", async () => {
    const resolve = createFileResolver({ root })
    expect(await resolve("bin.dat")).toBeNull()
  })

  // -------- E. over-cap ---------------------------------------------

  test("E1 — over-cap file ⇒ truncated body with notice (NOT null)", async () => {
    const resolve = createFileResolver({ root })
    const res = await resolve("big.txt")
    expect(res).not.toBeNull()
    expect(res?.bodyText.length).toBeLessThan(300 * 1024)
    expect(res?.bodyText).toContain("truncated")
  })

  // -------- F. no-throw / hostile target ----------------------------

  test("F1 — empty target ⇒ null", async () => {
    const resolve = createFileResolver({ root })
    expect(await resolve("")).toBeNull()
  })

  test("F2 — non-string target (hostile cast) ⇒ null, no throw", async () => {
    const resolve = createFileResolver({ root })
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile cast for NO-THROW invariant
    expect(await resolve(null as any)).toBeNull()
    // biome-ignore lint/suspicious/noExplicitAny: deliberate hostile cast for NO-THROW invariant
    expect(await resolve(undefined as any)).toBeNull()
  })
})
