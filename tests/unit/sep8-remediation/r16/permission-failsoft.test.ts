import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadPermissionStoreFailSoft } from "@/apps/cli/repl"
import type { PermissionStore } from "@/permission"

const REPL = join(process.cwd(), "src/apps/cli/repl.ts")

describe("G-F8 permission load fail-soft", () => {
  test("success does not warn", async () => {
    const store = {} as PermissionStore
    const seen: string[] = []
    const got = await loadPermissionStoreFailSoft(
      async () => store,
      (m) => seen.push(m),
    )
    expect(got).toBe(store)
    expect(seen).toEqual([])
  })

  test("rejection warns once and returns undefined", async () => {
    const seen: string[] = []
    const got = await loadPermissionStoreFailSoft(
      async () => {
        throw new Error(`ghp_${"A".repeat(36)}`)
      },
      (m) => seen.push(m),
    )
    expect(got).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain("cli.loadPermissionStore")
    expect(seen[0]).toContain("[REDACTED:github_pat_classic]")
    expect(seen[0]).not.toContain("ghp_")
  })

  test("throwing warning sink still returns undefined", async () => {
    const got = await loadPermissionStoreFailSoft(
      async () => {
        throw new Error("boom")
      },
      () => {
        throw new Error("sink")
      },
    )
    expect(got).toBeUndefined()
  })

  test("CLI boot consumer wires fail-soft, not a silent catch", () => {
    const src = readFileSync(REPL, "utf8")
    expect(src).toContain("loadPermissionStoreFailSoft")
    expect(src).toMatch(/loadPermissionStore:\s*\(\)\s*=>\s*\n\s*loadPermissionStoreFailSoft/)
    expect(src).not.toMatch(
      /loadPermissionStore:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?catch\s*\{[\s\S]*?return undefined/,
    )
  })
})
