import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

describe("slash state SSOT hellgate", () => {
  test("surface-compose projects slash state from the runtime bridge only", () => {
    const src = read("src/apps/cli/repl/surface-compose.ts")
    expect(src).toContain("toolProfileState: setup.runtimeContext.toolProfileState()")
    expect(src).toContain("identityModeState: setup.runtimeContext.identityModeState()")
    expect(src).toContain("onIdentityModeChange: setup.refreshSystemPrompt")
    expect(src).toContain("focusChain: setup.runtimeContext.focusChain()")
  })

  test("slash adapters prefer authoritative session-owned state", () => {
    const src = read("src/apps/cli/repl/slash-surface.ts")
    expect(src).toContain("const tp = args.toolProfileState")
    expect(src).toContain("const im = args.identityModeState")
    expect(src).toContain("args.focusChain !== undefined")
    expect(src).toContain("buildFocusChainAdapter(args.focusChain.tracker)")
  })

  test("runtime deps and AgentConfig expose the same live state slots", () => {
    const deps = read("src/host/runtime/internal/context-binding/base.ts")
    expect(deps).toContain('whenDefined("toolProfileState", args.boot.toolProfileState)')
    expect(deps).toContain('whenDefined("identityModeState", args.boot.identityModeState)')
    expect(deps).toContain('whenDefined("focusChain", args.boot.focusChain)')

    const config = read("src/runner/assemble/config.ts")
    expect(config).toContain("system: d.systemSource?.get() ?? d.system")
    expect(config).toContain('activeName: () => state.get() ?? state.defaultName ?? "write"')
    expect(config).toContain('activeMode: () => state.get() ?? state.defaultMode ?? "default"')
    expect(config).toContain("...(d.focusChain !== undefined ? { focusChain: d.focusChain } : {})")
  })
})
