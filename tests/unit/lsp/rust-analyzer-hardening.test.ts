import { describe, expect, test } from "bun:test"
import { resolveWorkspaceConfiguration } from "@/lsp/adapters/base/workspace"
import { buildRustAnalyzerHardening } from "@/lsp/adapters/rust-analyzer"

/**
 * SEC-2 (rust-analyzer). Runtime-UNVERIFIED (no server installed): this asserts
 * the config STRUCTURE the server would receive for its `rust-analyzer` section,
 * i.e. that the three code-execution vectors are disabled. It does NOT prove the
 * server honours it — that needs a real rust-analyzer.
 */
describe("rust-analyzer SEC-2 hardening config", () => {
  const cfg = buildRustAnalyzerHardening()

  test("build scripts are disabled (build.rs execution vector)", () => {
    const section = resolveWorkspaceConfiguration(cfg, "rust-analyzer") as Record<string, unknown>
    expect((section.cargo as Record<string, unknown>).runBuildScripts).toBe(false)
    expect(
      ((section.cargo as Record<string, unknown>).buildScripts as Record<string, unknown>).enable,
    ).toBe(false)
  })

  test("proc-macros are disabled (proc-macro execution vector)", () => {
    const section = resolveWorkspaceConfiguration(cfg, "rust-analyzer") as Record<string, unknown>
    expect((section.procMacro as Record<string, unknown>).enable).toBe(false)
  })

  test("check-on-save is off (cargo check shell-out vector)", () => {
    const section = resolveWorkspaceConfiguration(cfg, "rust-analyzer") as Record<string, unknown>
    expect(section.checkOnSave).toBe(false)
  })

  test("the section resolves via the same dotted walk the base uses for the server", () => {
    // the base answers workspace/configuration by walking the dotted section;
    // an unknown section must be null (server treats as unset), proving our key
    // name matches what rust-analyzer asks for.
    expect(resolveWorkspaceConfiguration(cfg, "rust-analyzer")).not.toBeNull()
    expect(resolveWorkspaceConfiguration(cfg, "python")).toBeNull()
  })
})
