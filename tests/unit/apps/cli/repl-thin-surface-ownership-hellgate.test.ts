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
    // src/apps/cli/repl.ts import-fences (@/host/runtime/session-host, @/runner, @/runner/session-execution-plane, **/execution-plane-wire) migrated to biome noRestrictedImports (see biome.json).

    const deps = read("src/apps/cli/repl/runtime-context-compose.ts")
    expect(deps).toContain('from "@/sdk/runtime"')
    expect(deps).toContain("composeRuntimeBootstrapContext")
    // runtime-context-compose.ts import-fences (@/sdk/runtime/bridge, @/runner/assemble/config, @/runner/session-memory-auto, **/session-memory-auto) migrated to biome noRestrictedImports (see biome.json).

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

  test("CLI runtime wiring does not mutate the SDK runtime context after bootstrap", () => {
    const runtimeContextCompose = read("src/apps/cli/repl/runtime-context-compose.ts")
    const surfaceCompose = read("src/apps/cli/repl/surface-compose.ts")
    const sessionLoop = read("src/apps/cli/repl/session-loop.ts")

    expect(runtimeContextCompose).not.toContain(".withAdmissibility(")
    expect(surfaceCompose).not.toContain(".wrapRegistry(")
    expect(surfaceCompose).not.toContain(".setGranularRegistry(")
    expect(sessionLoop).not.toContain(".ensureAutomationEngine(")
  })
})
