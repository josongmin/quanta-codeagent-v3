import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkSkillSize, MAX_SKILL_SIZE_BYTES } from "@/skill/skill-size"

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "skill-size-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("MAX_SKILL_SIZE_BYTES", () => {
  test("equals 30 MB exactly (Anthropic public limit)", () => {
    expect(MAX_SKILL_SIZE_BYTES).toBe(30 * 1024 * 1024)
  })
})

describe("checkSkillSize", () => {
  test("missing file ⇒ ok:false reason:stat-failed", async () => {
    const result = await checkSkillSize(join(tmp, "missing.md"))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("stat-failed")
      expect(result.size).toBe(0)
    }
  })

  test("small file ⇒ ok:true with actual size", async () => {
    const path = join(tmp, "small.md")
    await writeFile(path, "hello\n")
    const result = await checkSkillSize(path)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.size).toBe(6)
  })

  test("file at MAX (exactly) ⇒ ok:true (boundary inclusive)", async () => {
    const path = join(tmp, "at-max.bin")
    await writeFile(path, "")
    await truncate(path, MAX_SKILL_SIZE_BYTES)
    const result = await checkSkillSize(path)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.size).toBe(MAX_SKILL_SIZE_BYTES)
  })

  test("file at MAX+1 ⇒ ok:false reason:too-large", async () => {
    const path = join(tmp, "too-big.bin")
    await writeFile(path, "")
    await truncate(path, MAX_SKILL_SIZE_BYTES + 1)
    const result = await checkSkillSize(path)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("too-large")
      expect(result.size).toBe(MAX_SKILL_SIZE_BYTES + 1)
      expect(result.path).toBe(path)
    }
  })

  test("discriminated narrowing compiles (type-level)", async () => {
    const path = join(tmp, "narrow.md")
    await writeFile(path, "x")
    const r = await checkSkillSize(path)
    // Static-shape assertion: the ok-branch exposes `size: number` only.
    if (r.ok) {
      const _: number = r.size
      expect(_).toBeGreaterThanOrEqual(0)
    } else {
      const _: "too-large" | "stat-failed" = r.reason
      expect(typeof _).toBe("string")
    }
  })

  test("concurrent calls on same file are safe", async () => {
    const path = join(tmp, "concurrent.md")
    await writeFile(path, "abc")
    const results = await Promise.all([
      checkSkillSize(path),
      checkSkillSize(path),
      checkSkillSize(path),
    ])
    for (const r of results) {
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.size).toBe(3)
    }
  })
})
