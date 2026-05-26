import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

describe("runner public old-seam hellgate", () => {
  test("top-level runner barrel does not re-export legacy interactive/runtime config seams", async () => {
    const runner = await import("@/runner")
    expect("runInteractive" in runner).toBe(false)
    expect("runOnce" in runner).toBe(false)
    expect("assembleConfig" in runner).toBe(false)
    expect("buildSharedExecutionPlaneSessionDeps" in runner).toBe(false)
    expect("buildSessionMemoryAutoWires" in runner).toBe(false)
    expect("prepareSessionStartMemory" in runner).toBe(false)
  })

  test("runner sub-barrels do not re-export the old seam", async () => {
    const orchestrate = await import("@/runner/orchestrate")
    const assemble = await import("@/runner/assemble")

    expect("runInteractive" in orchestrate).toBe(false)
    expect("runOnce" in orchestrate).toBe(false)
    expect("assembleConfig" in assemble).toBe(false)

    const orchestrateSrc = read("src/runner/orchestrate/index.ts")
    const assembleSrc = read("src/runner/assemble/index.ts")

    expect(orchestrateSrc).not.toMatch(/export\s+type\s+\{[^}]*PromptSource/)
    expect(orchestrateSrc).not.toMatch(/export\s+type\s+\{[^}]*PromptPayload/)
    expect(orchestrateSrc).not.toMatch(/export\s+\{[^}]*runInteractive/)
    expect(orchestrateSrc).not.toMatch(/export\s+\{[^}]*runOnce/)
    expect(assembleSrc).not.toMatch(/export\s+\{[^}]*assembleConfig/)
    expect(assembleSrc).not.toMatch(/export\s+\{[^}]*type\s+SessionDeps/)
  })

  test("cli no longer carries the config-assemble shim", () => {
    expect(existsSync(join(REPO_ROOT, "src/apps/cli/config-assemble.ts"))).toBe(false)
  })

  test("runner no longer carries dead interactive loop helper files", () => {
    expect(existsSync(join(REPO_ROOT, "src/runner/orchestrate/run-interactive.ts"))).toBe(false)
    expect(existsSync(join(REPO_ROOT, "src/runner/orchestrate/prompt-source.ts"))).toBe(false)
    expect(read("src/runner/orchestrate/run-once.ts")).toContain('./prompt-payload"')
  })
})
