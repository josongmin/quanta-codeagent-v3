import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")
const exists = (path: string): boolean => existsSync(join(REPO_ROOT, path))

describe("CLI repl thin-surface ownership hellgate", () => {
  test("runner-owned session assemblers do not live under the CLI repl surface", () => {
    expect(exists("src/apps/cli/repl/execution-plane-wire.ts")).toBe(false)
    expect(exists("src/apps/cli/repl/session-memory-auto.ts")).toBe(false)
  })

  test("CLI repl host uses the single runner compat owner instead of raw compat primitives", () => {
    const repl = read("src/apps/cli/repl.ts")
    expect(repl).not.toContain('from "@/host/runtime/session-host"')
    expect(repl).not.toContain('from "@/runner"')
    expect(repl).not.toContain('from "@/runner/session-execution-plane"')
    expect(repl).not.toContain("./repl/execution-plane-wire")

    const deps = read("src/apps/cli/repl/session-deps-compose.ts")
    expect(deps).toContain('from "@/sdk/runtime/compat"')
    expect(deps).toContain("composeBootstrapLegacySessionDeps")
    expect(deps).not.toContain('from "@/runner/session-memory-auto"')
    expect(deps).not.toContain("./session-memory-auto")

    const setup = read("src/apps/cli/repl/session-setup.ts")
    expect(setup).not.toContain("buildLegacySideConversationPort")
    expect(setup).not.toContain("./side-conv-wire")
  })

  test("Biome pins the CLI repl against runner-internal session assembler imports", () => {
    const biome = read("biome.json")
    expect(biome).toContain('"includes": ["**/src/apps/cli/repl.ts", "**/src/apps/cli/repl/**"]')
    expect(biome).toContain('"@/runner/session-execution-plane"')
    expect(biome).toContain('"@/runner/session-memory-auto"')
    expect(biome).toContain('"**/execution-plane-wire"')
    expect(biome).toContain('"**/session-memory-auto"')
    expect(biome).toContain("Use the sanctioned runner-owned modules instead.")
  })
})
