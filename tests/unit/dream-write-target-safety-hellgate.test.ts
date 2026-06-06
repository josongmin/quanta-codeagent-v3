/**
 * ★ HELLGATE — H16 `FileDreamWriteTarget` SAFETY (jun-06 adversarial harden).
 *
 * The dream write target writes consolidated cross-session knowledge to a
 * SEPARATE `team/` file and REFUSES to ever write the user's live `MEMORY.md`.
 * Round-1 left the refusal at a single literal basename compare
 * (`basename === "MEMORY.md"`) and the path math un-jailed + non-atomic +
 * uncapped. This battery attacks all four:
 *
 *   1. MEMORY.md-REFUSAL-BYPASS: case (`memory.md`, `MEMORY.MD`), traversal
 *      (`team/../MEMORY.md`), an intermediate `MEMORY.md` dir component, a NUL
 *      byte — the refusal must hold for EVERY MEMORY.md-class target, not just
 *      the literal.
 *   2. JAIL-ESCAPE: a `memoryRoot` carrying `..` must NOT let the resolved
 *      target escape the (normalized) root; a relative root is rejected.
 *   3. ATOMIC: a crash mid-write must never leave a torn file at the target
 *      (temp-then-rename); the temp is cleaned on a rename failure.
 *   4. CAP: an enormous consolidated dream is bounded, not written unbounded.
 *
 * Determinism: in-memory fs fake — no real disk, no clock, no env.
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as fsp from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DREAM_TEAM_CONTENT_MAX_BYTES,
  type DreamFsPort,
  FileDreamWriteTarget,
  resolveDreamTeamPath,
} from "../../src/memory/dream/team-write-target"

/** In-memory fs fake recording every writeFile/rename so the test can assert
 *  WHAT landed WHERE (and that nothing torn survives). */
class FakeFs implements DreamFsPort {
  readonly files = new Map<string, string>()
  readonly mkdirCalls: string[] = []
  failRenameWith?: Error
  async mkdir(p: string): Promise<string | undefined> {
    this.mkdirCalls.push(p)
    return undefined
  }
  async writeFile(p: string, content: string): Promise<void> {
    this.files.set(p, content)
  }
  async rename(from: string, to: string): Promise<void> {
    if (this.failRenameWith) throw this.failRenameWith
    const v = this.files.get(from)
    if (v === undefined) throw new Error(`ENOENT rename ${from}`)
    this.files.delete(from)
    this.files.set(to, v)
  }
  async unlink(p: string): Promise<void> {
    this.files.delete(p)
  }
}

const mkTarget = (memoryRoot: string, fs: DreamFsPort = new FakeFs()) =>
  new FileDreamWriteTarget({ memoryRoot, fs })

describe("FileDreamWriteTarget — MEMORY.md refusal bypass (defense-in-depth)", () => {
  // Force the pathological basename the guard must defend against, across the
  // whole MEMORY.md class — NOT just the literal "MEMORY.md".
  const memoryClassTargets = [
    "/root/MEMORY.md", // literal (round-1 caught this one)
    "/root/memory.md", // case (lowercase)
    "/root/MEMORY.MD", // case (uppercase ext)
    "/root/Memory.Md", // mixed case
    "/root/team/../MEMORY.md", // traversal collapses to /root/MEMORY.md
    "/root/MEMORY.md/cross-session.md", // MEMORY.md as a DIR component
  ]

  for (const evil of memoryClassTargets) {
    test(`refuses a target resolving to MEMORY.md: ${evil}`, async () => {
      const fs = new FakeFs()
      const target = mkTarget("/root", fs)
      ;(target as unknown as { targetPath: string }).targetPath = evil
      await expect(target.write("x")).rejects.toThrow(/MEMORY\.md/i)
      // and NOTHING landed
      expect(fs.files.size).toBe(0)
    })
  }

  test("refuses a target path containing a NUL byte (poison)", async () => {
    const fs = new FakeFs()
    const target = mkTarget("/root", fs)
    ;(target as unknown as { targetPath: string }).targetPath = "/root/team/cross\x00.md"
    await expect(target.write("x")).rejects.toThrow()
    expect(fs.files.size).toBe(0)
  })
})

describe("resolveDreamTeamPath — jail", () => {
  test("a normal root resolves under <root>/team/cross-session.md", () => {
    expect(resolveDreamTeamPath("/safe/root")).toBe("/safe/root/team/cross-session.md")
  })

  test("JAIL-ESCAPE: a root with .. that escapes its own prefix is rejected", () => {
    // /safe/root/../../etc → /etc/team/... escapes the /safe/root subtree.
    expect(() => resolveDreamTeamPath("/safe/root/../../etc")).toThrow(/jail|escape|root/i)
  })

  test("a relative root is rejected (must be absolute to be jailable)", () => {
    expect(() => resolveDreamTeamPath("relative/root")).toThrow()
  })

  test("a root containing a NUL byte is rejected", () => {
    expect(() => resolveDreamTeamPath("/safe/\x00/root")).toThrow()
  })
})

describe("FileDreamWriteTarget — atomic write", () => {
  test("writes via temp-then-rename (no direct write to the final target)", async () => {
    const fs = new FakeFs()
    const target = mkTarget("/root", fs)
    const n = await target.write("hello dream")
    expect(n).toBe(Buffer.byteLength("hello dream", "utf8"))
    // final target has the content
    expect(fs.files.get(target.targetPath)).toBe("hello dream")
    // a temp sibling was used (and renamed away — only the final file remains)
    expect([...fs.files.keys()]).toEqual([target.targetPath])
  })

  test("ATOMIC: a rename failure leaves NO torn file at the target + cleans the temp", async () => {
    const fs = new FakeFs()
    fs.failRenameWith = new Error("EXDEV cross-device")
    const target = mkTarget("/root", fs)
    await expect(target.write("partial")).rejects.toThrow()
    // The final target must NOT exist (never half-written)
    expect(fs.files.has(target.targetPath)).toBe(false)
    // The temp must be cleaned up — no orphan torn file anywhere
    expect(fs.files.size).toBe(0)
  })
})

describe("FileDreamWriteTarget — symlink-to-MEMORY.md attack (real fs)", () => {
  let realRoot: string | undefined
  afterEach(() => {
    if (realRoot !== undefined) rmSync(realRoot, { recursive: true, force: true })
    realRoot = undefined
  })

  test("SYMLINK-ESCAPE: a team target symlinked to MEMORY.md does NOT clobber MEMORY.md (temp+rename defeats the follow)", async () => {
    realRoot = mkdtempSync(join(tmpdir(), "quanta-dream-sym-"))
    const r = realRoot
    const teamDir = join(r, "team")
    mkdirSync(teamDir, { recursive: true })
    const target = join(teamDir, "cross-session.md")
    const memoryMd = join(r, "MEMORY.md")
    writeFileSync(memoryMd, "ORIGINAL LIVE MEMORY", "utf8")
    // Attacker plants a symlink at the team target → live MEMORY.md.
    symlinkSync(memoryMd, target)

    const nodeFs: DreamFsPort = {
      mkdir: (p, opts) => fsp.mkdir(p, opts),
      writeFile: (p, c, enc) => fsp.writeFile(p, c, enc),
      rename: (from, to) => fsp.rename(from, to),
      unlink: (p) => fsp.unlink(p),
    }
    const wt = new FileDreamWriteTarget({ memoryRoot: r, fs: nodeFs })
    await wt.write("DREAM CONTENT")

    // The live MEMORY.md must be UNTOUCHED — the rename replaced the symlink
    // itself, it did NOT follow it into MEMORY.md.
    expect(readFileSync(memoryMd, "utf8")).toBe("ORIGINAL LIVE MEMORY")
    // The target is now a real file (the symlink was replaced), holding the dream.
    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(readFileSync(target, "utf8")).toBe("DREAM CONTENT")
  })
})

describe("FileDreamWriteTarget — content cap", () => {
  test("caps an enormous consolidated dream at DREAM_TEAM_CONTENT_MAX_BYTES", async () => {
    const fs = new FakeFs()
    const target = mkTarget("/root", fs)
    const huge = "x".repeat(DREAM_TEAM_CONTENT_MAX_BYTES * 3)
    const n = await target.write(huge)
    expect(n).toBeLessThanOrEqual(DREAM_TEAM_CONTENT_MAX_BYTES)
    const written = fs.files.get(target.targetPath) ?? ""
    expect(Buffer.byteLength(written, "utf8")).toBeLessThanOrEqual(DREAM_TEAM_CONTENT_MAX_BYTES)
  })

  test("a non-string content is rejected (type-poison guard)", async () => {
    const target = mkTarget("/root")
    await expect(target.write(undefined as unknown as string)).rejects.toThrow()
  })
})
