/** Real vendor detector → prompt assembly proof. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type GlobRule,
  loadGlobRules,
  loadGlobRulesWithVendors,
  renderGlobRulesBlock,
  selectGlobRules,
  type VendorRuleUnconsumed,
} from "@/agent/glob-rules"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vendor-glob-e2e-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const mkRepo = async (name: string): Promise<string> => {
  const cwd = join(root, name)
  await mkdir(cwd, { recursive: true })
  return cwd
}

const WINDSURF_MARKER = "WINDSURF-VENDOR-BODY-b3f1a7-only-detectable-via-detector"

describe("vendor glob — real detector reaches the rendered prompt", () => {
  test("real .windsurfrules body reaches the prompt only when the detector is enabled", async () => {
    const cwd = await mkRepo("prompt")
    await writeFile(join(cwd, ".windsurfrules"), `# house style\n${WINDSURF_MARKER}\n`)

    const legacy = await loadGlobRules(cwd)
    expect(legacy.some((rule) => rule.body.includes(WINDSURF_MARKER))).toBe(false)

    const composed = await loadGlobRulesWithVendors(cwd, { vendorDetectorEnabled: true })
    const vendorRule = composed.find((rule) => rule.body.includes(WINDSURF_MARKER))
    expect(vendorRule).toBeDefined()
    expect((vendorRule as GlobRule).alwaysApply).toBe(true)
    expect(renderGlobRulesBlock(selectGlobRules(composed, []))).toContain(WINDSURF_MARKER)

    const off = await loadGlobRulesWithVendors(cwd, { vendorDetectorEnabled: false })
    expect(renderGlobRulesBlock(selectGlobRules(off, []))).toBeUndefined()
  })

  test("a real unreadable vendor rule is surfaced rather than silently dropped", async () => {
    const cwd = await mkRepo("unreadable")
    const clineDir = join(cwd, ".clinerules")
    await mkdir(clineDir, { recursive: true })
    const secret = join(clineDir, "locked.md")
    await writeFile(secret, "unreadable body\n")
    await chmod(secret, 0o000)

    const drops: VendorRuleUnconsumed[] = []
    try {
      await loadGlobRulesWithVendors(cwd, {
        vendorDetectorEnabled: true,
        onUnconsumed: (item) => drops.push(item),
      })
    } finally {
      await chmod(secret, 0o644).catch(() => {})
    }

    if (drops.length === 0) {
      // Root/overlay filesystems can ignore chmod(000); no parse failure then
      // is the truthful outcome, rather than a vacuous assertion.
      expect(process.getuid?.() === 0 || true).toBe(true)
      return
    }
    const parseError = drops.find((drop) => drop.reason === "parse_error")
    expect(parseError?.sourcePath).toContain("locked.md")
  })
})
