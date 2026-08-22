/**
 * Keystone hellgate — `buildEvidence` orchestration over INJECTED fake sources
 * (deterministic; no real toolchain). Proves the assembly contract: a failing
 * test fuses failure+runtime+static+repo into ONE packet; every source degrades
 * independently; a green suite yields a null failure; a THROWING source never
 * breaks the build (NEVER-throws). red-on-injection: dropping any wiring leg or
 * letting a source throw turns these red.
 */
import { describe, expect, test } from "bun:test"
import { buildEvidence, type EvidenceSources } from "@/tool/evidence/builder"
import type { TestRunResult, Toolchain } from "@/tool/testrun"

const RUST: Toolchain = { kind: "rust", command: ["cargo", "test"], parser: "cargo" }

const failing: TestRunResult = {
  runner: "cargo",
  passed: 3,
  ok: false,
  failed: [{ name: "tests::fail_test", file: "src/lib.rs", line: 6, message: "assertion failed" }],
}
const green: TestRunResult = { runner: "cargo", passed: 4, ok: true, failed: [] }

const baseSources = (over: Partial<EvidenceSources> = {}): EvidenceSources => ({
  detect: async () => RUST,
  runTests: async () => failing,
  ...over,
})

describe("buildEvidence — keystone orchestration", () => {
  test("FULL packet: fuses failure + runtime + static + repo for the top failure", async () => {
    const seen: { staticAt?: [string, number]; runtimeFor?: string } = {}
    const pkt = await buildEvidence(
      "/repo",
      baseSources({
        changedFiles: async () => ["src/lib.rs", "README.md"],
        lspStatic: async (file, line) => {
          seen.staticAt = [file, line]
          return {
            definition_chain: [{ file: "src/lib.rs", line: 1 }],
            references: [{ file: "src/main.rs", line: 9 }],
            type_info: "fn add(a: i32, b: i32) -> i32",
            diagnostics: [],
          }
        },
        runtime: async (f, tc) => {
          seen.runtimeFor = f.test_name
          expect(tc.kind).toBe("rust") // toolchain threaded to the runtime source
          return {
            stack: [{ name: "add", file: "src/lib.rs", line: 6 }],
            locals: [{ name: "a", value: "2" }],
          }
        },
      }),
    )
    expect(pkt.language).toBe("rust")
    expect(pkt.failure?.test_name).toBe("tests::fail_test")
    expect(pkt.failure?.file).toBe("src/lib.rs")
    // Static + runtime were queried AT THE FAILURE SITE (absolute path) / for
    // the failing test.
    expect(seen.staticAt).toEqual(["/repo/src/lib.rs", 6])
    expect(seen.runtimeFor).toBe("tests::fail_test")
    expect(pkt.static?.type_info).toContain("fn add")
    expect(pkt.runtime?.stack[0]?.name).toBe("add")
    expect(pkt.repo_context.changed_files).toContain("src/lib.rs")
  })

  test("GREEN suite ⇒ failure null, no static/runtime queried", async () => {
    let staticCalls = 0
    const pkt = await buildEvidence(
      "/repo",
      baseSources({
        runTests: async () => green,
        lspStatic: async () => {
          staticCalls++
          return null
        },
      }),
    )
    expect(pkt.failure).toBeNull()
    expect(pkt.static).toBeNull()
    expect(pkt.runtime).toBeNull()
    expect(staticCalls).toBe(0) // nothing to localize ⇒ no LSP work
  })

  test("PARTIAL: no LSP/runtime ports ⇒ packet still built from failure + repo", async () => {
    const pkt = await buildEvidence(
      "/repo",
      baseSources({ changedFiles: async () => ["src/lib.rs"] }),
    )
    expect(pkt.failure?.test_name).toBe("tests::fail_test")
    expect(pkt.static).toBeNull()
    expect(pkt.runtime).toBeNull()
    expect(pkt.repo_context.changed_files).toEqual(["src/lib.rs"])
  })

  test("NEVER-throws: a throwing source degrades that section, packet still returns", async () => {
    const pkt = await buildEvidence(
      "/repo",
      baseSources({
        lspStatic: async () => {
          throw new Error("lsp crashed")
        },
        runtime: async () => {
          throw new Error("dap crashed")
        },
        changedFiles: async () => {
          throw new Error("git crashed")
        },
      }),
    )
    expect(pkt.failure?.test_name).toBe("tests::fail_test") // failure survives
    expect(pkt.static).toBeNull() // crashed source ⇒ null, not a thrown packet
    expect(pkt.runtime).toBeNull()
    expect(pkt.repo_context.changed_files).toEqual([])
  })

  test("no toolchain detected ⇒ failure null, language 'unknown', never throws", async () => {
    const pkt = await buildEvidence("/repo", baseSources({ detect: async () => null }))
    expect(pkt.failure).toBeNull()
    expect(pkt.language).toBe("unknown")
  })

  test("static is queried at the FIRST failure that has a file+line (skips locationless ones)", async () => {
    const multi: TestRunResult = {
      runner: "go",
      passed: 0,
      ok: false,
      failed: [
        { name: "TestNoLoc" }, // no file/line
        { name: "TestLoc", file: "m_test.go", line: 12 },
      ],
    }
    let at: [string, number] | undefined
    await buildEvidence(
      "/repo",
      baseSources({
        detect: async () => ({ kind: "go", command: ["go", "test"], parser: "go" }),
        runTests: async () => multi,
        lspStatic: async (f, l) => {
          at = [f, l]
          return null
        },
      }),
    )
    expect(at).toEqual(["/repo/m_test.go", 12]) // resolved to absolute against cwd
  })

  test("patch_constraints flow through from options (default: no public API change)", async () => {
    const def = await buildEvidence("/repo", baseSources())
    expect(def.patch_constraints.public_api_change_allowed).toBe(false)
    const custom = await buildEvidence("/repo", baseSources(), {
      patchConstraints: { public_api_change_allowed: true, style: "match-surrounding" },
    })
    expect(custom.patch_constraints.public_api_change_allowed).toBe(true)
    expect(custom.patch_constraints.style).toBe("match-surrounding")
  })
})
