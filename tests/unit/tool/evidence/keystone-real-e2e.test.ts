/**
 * Keystone REAL e2e — proves `buildEvidence` FUSES two live subsystems into one
 * packet: a real `cargo test` failure (run_tests) + real rust-analyzer LSP
 * static at the failure site. No fakes for the fused sources. AUTO-SKIPS when
 * cargo + rust-analyzer are absent. Verified 2026-06-10.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RustAnalyzerAdapter } from "@/lsp"
import { buildEvidence, type EvidenceSources } from "@/tool/evidence/builder"
import type { StaticEvidence } from "@/tool/evidence/types"
import { detectToolchain, runToolchain } from "@/tool/testrun"

const has = (bin: string, ...a: string[]): boolean => {
  try {
    return Bun.spawnSync([bin, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const D = has("cargo", "--version") && has("rust-analyzer", "--version") ? describe : describe.skip

/** Real rust-analyzer static source: hover across the failure line (cold-index
 *  tolerant — poll + ignore ContentModified) → type_info. */
const realRustStatic = (): EvidenceSources["lspStatic"] => async (file, line, cwd) => {
  const a = new RustAnalyzerAdapter({ cwd })
  // LSP needs an ABSOLUTE path (run_tests reports cargo's relative `src/lib.rs`).
  const abs = file.startsWith("/") ? file : join(cwd, file)
  try {
    await a.start()
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      for (let ch = 4; ch < 60; ch += 3) {
        try {
          const hov = await a.hover(abs, { line: line - 1, character: ch })
          const txt = hov === null ? "" : JSON.stringify(hov)
          if (txt.includes("fn ") || txt.includes("i32")) {
            const ev: StaticEvidence = { definition_chain: [], references: [], type_info: txt, diagnostics: [] }
            return ev
          }
        } catch (e) {
          if (!/content modified/i.test(String(e))) throw e
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return { definition_chain: [], references: [], type_info: null, diagnostics: [] }
  } finally {
    await a.stop()
  }
}

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
      lspStatic: realRustStatic(),
      changedFiles: async () => ["src/lib.rs"],
    }
    const pkt = await buildEvidence(dir, sources)

    // Real cargo failure fused in.
    expect(pkt.language).toBe("rust")
    expect(pkt.failure?.test_name).toContain("fail_test")
    expect(pkt.failure?.file).toContain("lib.rs")
    // Real rust-analyzer static fused in at the SAME packet.
    expect(pkt.static).not.toBeNull()
    expect(typeof pkt.static?.type_info).toBe("string")
    expect(pkt.static?.type_info ?? "").toMatch(/fn |i32/)
    expect(pkt.repo_context.changed_files).toContain("src/lib.rs")
  }, 90_000)
})
