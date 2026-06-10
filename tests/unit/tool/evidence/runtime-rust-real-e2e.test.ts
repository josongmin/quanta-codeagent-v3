/**
 * Keystone runtime — REAL Rust e2e (lldb-dap). Extends the runtime port to a
 * SECOND language: `cargo test --no-run` builds the test binary, lldb-dap runs
 * it with a breakpoint at the failing test's line, and the captured locals show
 * the value that explains the failure (`result = 10` vs expected 99) — fused
 * into the Evidence Packet's `runtime` section.
 *
 * AUTO-SKIPS without cargo + lldb-dap. Verified 2026-06-10.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildEvidence } from "@/tool/evidence/builder"
import { defaultRuntimePort } from "@/tool/evidence"
import { detectToolchain, runToolchain } from "@/tool/testrun"

const has = (b: string, ...a: string[]): boolean => {
  try {
    return Bun.spawnSync([b, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const lldbAvailable = (): boolean => {
  if (has("lldb-dap", "--help")) return true
  try {
    const r = Bun.spawnSync(["xcrun", "-f", "lldb-dap"], { stdout: "pipe", stderr: "ignore" })
    return r.exitCode === 0 && r.stdout.toString().trim().length > 0
  } catch {
    return false
  }
}
const D = has("cargo", "--version") && lldbAvailable() ? describe : describe.skip

const LIB_RS = [
  "pub fn compute(n: i32) -> i32 { let mut t = 0; for i in 0..n { t += i; } t }",
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  "    #[test]",
  "    fn fail_test() {",
  "        let result = compute(5);",
  "        assert_eq!(result, 99);  // line 8",
  "    }",
  "}",
].join("\n")

D("defaultRuntimePort — REAL Rust runtime via lldb-dap (second runtime language)", () => {
  test("buildEvidence captures the rust test's locals (the value behind the failure)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtrs-")))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "Cargo.toml"), ['[package]', 'name = "t"', 'version = "0.1.0"', 'edition = "2021"'].join("\n"))
    writeFileSync(join(dir, "src", "lib.rs"), LIB_RS)

    const pkt = await buildEvidence(dir, {
      detect: (c) => detectToolchain(c, { fileExists: async (n) => existsSync(join(c, n)) }),
      runTests: (tc, c) => runToolchain(tc, c),
      runtime: defaultRuntimePort,
      changedFiles: async () => ["src/lib.rs"],
    })

    expect(pkt.language).toBe("rust")
    expect(pkt.failure?.test_name).toContain("fail_test")
    expect(pkt.runtime).not.toBeNull()
    const result = pkt.runtime?.locals.find((v) => v.name === "result")
    expect(result?.value).toBe("10")
    expect(pkt.runtime?.stack.some((f) => f.name.includes("fail_test"))).toBe(true)
  }, 180_000)
})
