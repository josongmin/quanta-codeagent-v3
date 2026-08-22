/**
 * Keystone remediation (adversarial-audit) — git porcelain parsing + the tool's
 * ok-semantics + absolute-path handoff, via fakes. red-on-injection: the naive
 * slice(3) parse, ok:true-always, and relative-path handoff all turn these red.
 */
import { describe, expect, test } from "bun:test"
import type { FileSystemPort } from "@/storage"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import { makeCollectEvidenceTool, parseGitPorcelain } from "@/tool/evidence/tool"
import type { TestRunResult, Toolchain } from "@/tool/testrun"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

describe("parseGitPorcelain", () => {
  test("plain modified / added / untracked", () => {
    const r = parseGitPorcelain([" M src/a.rs", "A  src/b.rs", "?? src/c.rs"].join("\n"))
    expect(r).toEqual(["src/a.rs", "src/b.rs", "src/c.rs"])
  })
  test("rename ⇒ takes the NEW path (after ->)", () => {
    expect(parseGitPorcelain("R  src/old.rs -> src/new.rs")).toEqual(["src/new.rs"])
  })
  test("quoted path with spaces ⇒ unquoted", () => {
    expect(parseGitPorcelain('M  "src/my file.rs"')).toEqual(["src/my file.rs"])
  })
  test("empty / blank ⇒ []", () => {
    expect(parseGitPorcelain("")).toEqual([])
    expect(parseGitPorcelain("\n  \n")).toEqual([])
  })
})

const RUST: Toolchain = { kind: "rust", command: ["cargo", "test"], parser: "cargo" }
const failing: TestRunResult = {
  runner: "cargo",
  passed: 1,
  ok: false,
  failed: [{ name: "t", file: "src/lib.rs", line: 6 }],
}
const _green: TestRunResult = { runner: "cargo", passed: 2, ok: true, failed: [] }

describe("buildEvidence — absolute-path handoff to enrichment ports", () => {
  test("lspStatic receives an ABSOLUTE path even when the failure file is relative", async () => {
    let got: string | undefined
    await buildEvidence("/repo/proj", {
      detect: async () => RUST,
      runTests: async () => failing,
      lspStatic: async (file) => {
        got = file
        return null
      },
    })
    expect(got).toBe("/repo/proj/src/lib.rs") // resolved against cwd, not the raw "src/lib.rs"
  })
  test("defaultRuntimePort degrades to null for an UNSUPPORTED toolchain (node — no spawn)", async () => {
    // Deterministic (no toolchain needed): runtime supports python+rust; a node
    // toolchain returns null before spawning anything.
    const NODE: Toolchain = { kind: "node", command: ["npm", "test"], parser: "generic" }
    const pkt = await buildEvidence("/repo", {
      detect: async () => NODE,
      runTests: async () => ({ ...failing, runner: "generic" }),
      runtime: defaultRuntimePort, // real port, but node ⇒ null
    })
    expect(pkt.failure?.test_name).toBe("t")
    expect(pkt.runtime).toBeNull()
  })

  test("an already-absolute failure file is passed through unchanged", async () => {
    let got: string | undefined
    await buildEvidence("/repo", {
      detect: async () => RUST,
      runTests: async () => ({ ...failing, failed: [{ name: "t", file: "/abs/x.rs", line: 1 }] }),
      lspStatic: async (file) => {
        got = file
        return null
      },
    })
    expect(got).toBe("/abs/x.rs")
  })
})

const fsWith = (present: string[]): FileSystemPort =>
  ({ fileExists: async (n: string) => present.includes(n) }) as unknown as FileSystemPort
const runTool = async (
  tool: ReturnType<typeof makeCollectEvidenceTool>,
  input: object = {},
): Promise<ToolResult> => {
  const ctx = { cwd: "/p", signal: new AbortController().signal } as ToolContext
  let r: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx) as AsyncIterable<ToolEvent>)
    if (ev.type === "result") r = ev.result
  if (r === undefined) throw new Error("no result")
  return r
}

describe("collect_evidence tool — ok semantics (consistent with run_tests)", () => {
  test("a failing suite ⇒ ok:false (red), packet in output", async () => {
    const tool = makeCollectEvidenceTool({
      fs: fsWith(["Cargo.toml"]),
      testPort: { run: async () => ({ stdout: "", stderr: "", exitCode: 101 }) },
      changedFiles: async () => [],
    })
    const r = await runTool(tool)
    expect(r.ok).toBe(false) // failure present ⇒ ok:false, like run_tests
    expect(r.output).toContain("failure")
  })
  test("a green suite ⇒ ok:true", async () => {
    const tool = makeCollectEvidenceTool({
      fs: fsWith(["go.mod"]),
      testPort: {
        run: async () => ({ stdout: '{"Action":"pass","Test":"A"}', stderr: "", exitCode: 0 }),
      },
      changedFiles: async () => [],
    })
    const r = await runTool(tool)
    expect(r.ok).toBe(true)
  })
})

describe("collect_evidence tool — nothing-actually-ran must NEVER be ok:true (silent-failure audit #5)", () => {
  // The tool is invoked BECAUSE a test is failing; an UNDETECTED toolchain
  // yields an empty packet (failure:null) which `ok = failure===null` used to
  // read as green. Mirror run_tests: explicit ok:false naming what was probed.
  test("UNDETECTED toolchain ⇒ ok:false with an actionable reason, suite never spawned", async () => {
    let runCalls = 0
    const tool = makeCollectEvidenceTool({
      fs: fsWith([]), // no marker files at all ⇒ detect → null
      testPort: {
        run: async () => {
          runCalls++
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      },
      changedFiles: async () => [],
    })
    const r = await runTool(tool)
    expect(runCalls).toBe(0) // nothing ran — that is exactly why ok:true is a lie
    expect(r.ok).toBe(false) // red-on-injection: `ok: failure===null` alone turns this green
    expect(r.output).toContain("no recognized test toolchain")
    expect(r.output).toContain("Cargo.toml") // names the markers it looked for (actionable)
    expect(r.failure?.mode).toBe("error") // run_tests' explicit error shape
  })

  test("detected toolchain but the run FAULTS (spawn error) ⇒ ok:false, never a green empty packet", async () => {
    const tool = makeCollectEvidenceTool({
      fs: fsWith(["Cargo.toml"]),
      testPort: {
        run: async () => {
          throw new Error("ENOENT: cargo not found")
        },
      },
      changedFiles: async () => [],
    })
    const r = await runTool(tool)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("faulted") // runToolchain's synthesized failure surfaces in the packet
  })

  // Paired control: a SUPPORTED repo keeps the documented behavior on both
  // sides — real failure ⇒ ok:false with the packet, green suite ⇒ ok:true.
  test("paired control — supported repo, real failure ⇒ ok:false with packet (unchanged)", async () => {
    const tool = makeCollectEvidenceTool({
      fs: fsWith(["Cargo.toml"]),
      testPort: { run: async () => ({ stdout: "", stderr: "", exitCode: 101 }) },
      changedFiles: async () => [],
    })
    const r = await runTool(tool)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('"failure"')
    expect(r.output).not.toContain("no recognized test toolchain")
  })
  test("paired control — supported repo, green suite ⇒ ok:true (unchanged)", async () => {
    const tool = makeCollectEvidenceTool({
      fs: fsWith(["go.mod"]),
      testPort: {
        run: async () => ({ stdout: '{"Action":"pass","Test":"A"}', stderr: "", exitCode: 0 }),
      },
      changedFiles: async () => [],
    })
    const r = await runTool(tool)
    expect(r.ok).toBe(true)
  })
})

describe("collect_evidence tool — per-section toggles", () => {
  // Real cargo shape: the `---- NAME stdout ----` block carries the panic
  // location, so parseCargo extracts file+line (needed for the static query).
  const failingCargo = {
    run: async () => ({
      stdout: [
        "test x ... FAILED",
        "",
        "failures:",
        "",
        "---- x stdout ----",
        "",
        "thread 'x' panicked at src/lib.rs:6:9:",
        "boom",
        "",
        "test result: FAILED. 0 passed; 1 failed;",
      ].join("\n"),
      stderr: "",
      exitCode: 101,
    }),
  }

  test("includeRuntime:false ⇒ the (expensive) DAP runtime source is NEVER invoked", async () => {
    let runtimeCalls = 0
    let staticCalls = 0
    const tool = makeCollectEvidenceTool({
      fs: fsWith(["Cargo.toml"]),
      testPort: failingCargo,
      changedFiles: async () => [],
      runtime: async () => {
        runtimeCalls++
        return { stack: [], locals: [] }
      },
      lspStatic: async () => {
        staticCalls++
        return { definition_chain: [], references: [], type_info: "x", diagnostics: [] }
      },
    })
    const r = await runTool(tool, { includeRuntime: false })
    const pkt = JSON.parse(r.output) as { runtime: unknown; static: unknown }
    expect(runtimeCalls).toBe(0) // toggled off ⇒ no debugger run
    expect(pkt.runtime).toBeNull()
    expect(staticCalls).toBe(1) // static still fetched
    expect(pkt.static).not.toBeNull()
  })

  test("includeStatic:false ⇒ the LSP static source is NEVER invoked", async () => {
    let staticCalls = 0
    const tool = makeCollectEvidenceTool({
      fs: fsWith(["Cargo.toml"]),
      testPort: failingCargo,
      changedFiles: async () => [],
      runtime: async () => ({ stack: [], locals: [] }),
      lspStatic: async () => {
        staticCalls++
        return null
      },
    })
    const r = await runTool(tool, { includeStatic: false })
    const pkt = JSON.parse(r.output) as { static: unknown }
    expect(staticCalls).toBe(0)
    expect(pkt.static).toBeNull()
  })
})
