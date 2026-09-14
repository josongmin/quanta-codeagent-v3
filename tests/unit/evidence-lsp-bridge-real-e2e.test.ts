/**
 * Keystone enrichment bridge — REAL e2e for the PRODUCTION `evidenceLspStatic()`
 * port (the @/agent wiring that makes collect_evidence's `static` section LIVE,
 * not just test-local). Drives a real rust-analyzer through `lspNavProvider` and
 * fuses it into a real buildEvidence packet. AUTO-SKIPS without cargo +
 * rust-analyzer. Verified 2026-06-10.
 */
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { buildEvidence } from "@/tool/evidence/builder"
import { detectToolchain, runToolchain } from "@/tool/testrun"
import {
  boundedVersion,
  capabilityGate,
  hasBinary,
  laneDescribe,
  reportExecuted,
} from "../_helpers/capability-lane"

const GROUP = "lsp-rust"
const FILE = "tests/unit/evidence-lsp-bridge-real-e2e.test.ts"

// CAPABILITY GROUP `lsp-rust`. A REAL rust-analyzer + cargo under the full
// parallel suite gets CPU-starved and returns an EMPTY hover ⇒ flake, so this
// runs only in the opt-in serial lane. The SAME fusion logic stays covered
// deterministically by evidence-lsp-bridge-replay-deterministic.test.ts
// (REPLAYED lspStatic port), which is why moving this file out of PR membership
// loses no coverage.
const GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { cargo: hasBinary("cargo"), "rust-analyzer": hasBinary("rust-analyzer") },
})
const D = laneDescribe(GATE)

const project = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "evbridge-")))
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(
    join(dir, "Cargo.toml"),
    ["[package]", 'name = "t"', 'version = "0.1.0"', 'edition = "2021"', "", "[workspace]"].join(
      "\n",
    ),
  )
  writeFileSync(
    join(dir, "src", "lib.rs"),
    [
      "pub fn add(a: i32, b: i32) -> i32 { a + b }",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "    #[test] fn fail_test() { assert_eq!(add(2, 2), 5); }",
      "}",
    ].join("\n"),
  )
  return dir
}

D("evidenceLspStatic — PRODUCTION LSP static port (real rust-analyzer)", () => {
  afterAll(() =>
    reportExecuted(GATE, GROUP, FILE, "real cargo + rust-analyzer exercised", () => ({
      cargoVersion: boundedVersion(["cargo", "--version"]),
      rustAnalyzerVersion: boundedVersion(["rust-analyzer", "--version"]),
    })),
  )

  test("queries the real server at a failure site and returns StaticEvidence", async () => {
    const dir = project()
    const port = evidenceLspStatic()
    // Failure is at lib.rs:6 (the assert line). Absolute path (builder normalizes).
    const ev = await port(join(dir, "src", "lib.rs"), 6, dir)
    expect(ev).not.toBeNull()
    // Real rust-analyzer returned hover content at a symbol on that line (the
    // exact symbol the column-scan lands on is non-deterministic, so assert real
    // non-empty content rather than over-fitting to one symbol).
    expect((ev?.type_info ?? "").length).toBeGreaterThan(0)
  }, 90_000)

  test("buildEvidence with the PRODUCTION port fuses real cargo failure + real static", async () => {
    const dir = project()
    const pkt = await buildEvidence(dir, {
      detect: (c) => detectToolchain(c, { fileExists: async (n) => existsSync(join(c, n)) }),
      runTests: (tc, c) => runToolchain(tc, c),
      lspStatic: evidenceLspStatic(),
      changedFiles: async () => ["src/lib.rs"],
    })
    expect(pkt.language).toBe("rust")
    expect(pkt.failure?.test_name).toContain("fail_test")
    expect(pkt.static).not.toBeNull()
    expect((pkt.static?.type_info ?? "").length).toBeGreaterThan(0) // real LSP hover content fused in
  }, 120_000)
})
