/**
 * Keystone REAL e2e — proves `buildEvidence` FUSES two live subsystems into one
 * packet: a real `cargo test` failure (run_tests) + real rust-analyzer LSP
 * static at the failure site. No fakes for the fused sources. AUTO-SKIPS when
 * cargo + rust-analyzer are absent. Verified 2026-06-10.
 */
import { describe, expect, test } from "bun:test"
import { gateOn } from "@/shared"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { buildEvidence, type EvidenceSources } from "@/tool/evidence/builder"
import { detectToolchain, runToolchain } from "@/tool/testrun"

const has = (bin: string, ...a: string[]): boolean => {
  try {
    return Bun.spawnSync([bin, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
// SOTA ① real-on-demand lane: real rust-analyzer+cargo thunders under the
// parallel suite (same root cause as evidence-lsp-bridge-real-e2e). Runs only
// when QUANTA_REAL_TOOLCHAIN_E2E is set (`bun run test:real-toolchain`, serial).
const D =
  gateOn(process.env, "QUANTA_REAL_TOOLCHAIN_E2E") &&
  has("cargo", "--version") &&
  has("rust-analyzer", "--version")
    ? describe
    : describe.skip

D("buildEvidence — REAL keystone fusion (cargo failure + rust-analyzer static)", () => {
  test("one call returns a packet fusing the real failure + real LSP static", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kst-")))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "Cargo.toml"), ['[package]', 'name = "t"', 'version = "0.1.0"', 'edition = "2021"'].join("\n"))
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
