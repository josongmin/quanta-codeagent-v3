/**
 * Keystone REAL e2e — proves `buildEvidence` FUSES two live subsystems into one
 * packet: a real `cargo test` failure (run_tests) + real rust-analyzer LSP
 * static at the failure site. No fakes for the fused sources. AUTO-SKIPS when
 * cargo + rust-analyzer are absent. Verified 2026-06-10.
 */
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { buildEvidence, type EvidenceSources } from "@/tool/evidence/builder"
import { detectToolchain, runToolchain } from "@/tool/testrun"
import {
  boundedVersion,
  capabilityGate,
  hasBinary,
  laneDescribe,
  reportExecuted,
} from "../../../_helpers/capability-lane"

const GROUP = "lsp-rust"
const FILE = "tests/unit/tool/evidence/keystone-real-e2e.test.ts"

// CAPABILITY GROUP `lsp-rust` — same real cargo + rust-analyzer as its two
// siblings, so one job provisions the toolchain once for all three.
const GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { cargo: hasBinary("cargo"), "rust-analyzer": hasBinary("rust-analyzer") },
})
const D = laneDescribe(GATE)

D("buildEvidence — REAL keystone fusion (cargo failure + rust-analyzer static)", () => {
  afterAll(() =>
    reportExecuted(
      GATE,
      GROUP,
      FILE,
      "real cargo failure fused with real rust-analyzer static",
      () => ({
        cargoVersion: boundedVersion(["cargo", "--version"]),
        rustAnalyzerVersion: boundedVersion(["rust-analyzer", "--version"]),
      }),
    ),
  )

  test("one call returns a packet fusing the real failure + real LSP static", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kst-")))
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

    const sources: EvidenceSources = {
      detect: (c) => detectToolchain(c, { fileExists: async (n) => existsSync(join(c, n)) }),
      runTests: (tc, c) => runToolchain(tc, c),
      lspStatic: evidenceLspStatic(), // the PRODUCTION port (hardened cold-index handling)
      changedFiles: async () => ["src/lib.rs"],
    }
    const pkt = await buildEvidence(dir, sources)

    // Real cargo failure fused in.
    expect(pkt.language).toBe("rust")
    expect(pkt.failure?.test_name).toContain("fail_test")
    expect(pkt.failure?.file).toContain("lib.rs")
    // Real rust-analyzer static fused in at the SAME packet.
    expect(pkt.static).not.toBeNull()
    expect((pkt.static?.type_info ?? "").length).toBeGreaterThan(0)
    expect(pkt.repo_context.changed_files).toContain("src/lib.rs")
  }, 90_000)
})
