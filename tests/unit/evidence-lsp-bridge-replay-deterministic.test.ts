/**
 * DETERMINISTIC replay of the keystone LSP-static fusion (SOTA ① — the
 * "default-deterministic, real-on-demand" split).
 *
 * `evidence-lsp-bridge-real-e2e.test.ts` drives a REAL rust-analyzer + cargo;
 * under the full parallel suite those external servers are CPU-starved and
 * return empty hover → the test flakes (it now lives behind the opt-in
 * QUANTA_REAL_TOOLCHAIN_E2E lane, run serially). This battery covers the SAME
 * production code path — `buildEvidence` fusing the LSP `static` section into
 * the Evidence Packet — but with the `lspStatic` port REPLAYED (canned, the
 * `EvidenceSources` seam is injectable), so it is fast, deterministic, and
 * carries zero external-process contention. It runs in the default suite; the
 * real round-trip is verified on-demand.
 *
 * RED-ON-INJECTION (teeth): if `buildEvidence` stops fusing the static section
 * (returns `static:null`), case 1 fails; if it stops normalizing the failure
 * file to an ABSOLUTE path before handing it to `lspStatic`, case 2 fails.
 */

import { describe, expect, test } from "bun:test"
import { isAbsolute } from "node:path"
import { buildEvidence } from "@/tool/evidence/builder"
import type { StaticEvidence } from "@/tool/evidence/types"
import type { TestRunResult, Toolchain } from "@/tool/testrun"

const RUST: Toolchain = { kind: "rust", command: ["cargo", "test"], parser: "cargo" }

const failingRun: TestRunResult = {
  runner: "cargo",
  passed: 0,
  failed: [{ name: "tests::fail_test", file: "src/lib.rs", line: 6, message: "assert_eq! failed" }],
  ok: false,
}

// The "cassette": what a real rust-analyzer returned at the failure site, recorded
// once. Replaying it removes the live-server round-trip (and its flake) entirely.
const RECORDED_STATIC: StaticEvidence = {
  type_info: "fn add(a: i32, b: i32) -> i32",
  definition_chain: [{ file: "src/lib.rs", line: 1 }],
  references: [{ file: "src/lib.rs", line: 6 }],
  diagnostics: [],
}

const sources = (lspStatic?: typeof replayStatic) => ({
  detect: async () => RUST,
  runTests: async (): Promise<TestRunResult> => failingRun,
  changedFiles: async () => ["src/lib.rs"],
  ...(lspStatic !== undefined ? { lspStatic } : {}),
})

const lspCalls: Array<{ file: string; line: number; cwd: string }> = []
const replayStatic = async (
  file: string,
  line: number,
  cwd: string,
): Promise<StaticEvidence | null> => {
  lspCalls.push({ file, line, cwd })
  return RECORDED_STATIC
}

describe("DETERMINISTIC: buildEvidence fuses a REPLAYED LSP static section", () => {
  test("the replayed static section is fused into the packet verbatim", async () => {
    const pkt = await buildEvidence("/work/proj", sources(replayStatic))
    expect(pkt.language).toBe("rust")
    expect(pkt.failure?.test_name).toContain("fail_test")
    // the FUSION — the static section must land in the packet
    expect(pkt.static).not.toBeNull()
    expect(pkt.static?.type_info).toBe("fn add(a: i32, b: i32) -> i32")
    expect(pkt.static?.definition_chain).toHaveLength(1)
    // diagnostics from static fuse into repo_context too
    expect(pkt.repo_context.diagnostics).toEqual([])
  })

  test("the failure file is normalized to an ABSOLUTE path before lspStatic is called", async () => {
    lspCalls.length = 0
    await buildEvidence("/work/proj", sources(replayStatic))
    expect(lspCalls).toHaveLength(1)
    const call = lspCalls[0]
    // the runner reported `src/lib.rs` (relative); the builder MUST hand LSP an abs path
    expect(isAbsolute(call?.file ?? "")).toBe(true)
    expect(call?.file).toBe("/work/proj/src/lib.rs")
    expect(call?.line).toBe(6)
  })

  test("a replayed null (server had no answer) ⇒ static:null, no crash", async () => {
    const pkt = await buildEvidence(
      "/work/proj",
      sources(async () => null),
    )
    expect(pkt.static).toBeNull()
    expect(pkt.failure?.test_name).toContain("fail_test") // rest of the packet still built
  })

  test("NEVER-throws: an lspStatic that throws is swallowed ⇒ static:null", async () => {
    const pkt = await buildEvidence(
      "/work/proj",
      sources(async () => {
        throw new Error("LSP server exploded")
      }),
    )
    expect(pkt.static).toBeNull()
    expect(pkt.language).toBe("rust")
  })

  test("no lspStatic provided (optional dep absent) ⇒ static:null", async () => {
    const pkt = await buildEvidence("/work/proj", sources())
    expect(pkt.static).toBeNull()
  })
})
