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
import { gateOn } from "@/shared"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
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
// SOTA ① real-on-demand lane: real cargo + lldb-dap thunders under the parallel
// suite. Runs only when QUANTA_REAL_TOOLCHAIN_E2E is set (`test:real-toolchain`).
const D =
  gateOn(process.env, "QUANTA_REAL_TOOLCHAIN_E2E") && has("cargo", "--version") && lldbAvailable()
    ? describe
    : describe.skip

const LIB_RS = [
  "pub fn compute(n: i32) -> i32 { let mut t = 0; for i in 0..n { t += i; } t }",
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  "    #[test]",
  "    fn fail_test() {",
  "        let items: Vec<i32> = vec![10, 20, 30];",
  "        let result = compute(5);",
  "        assert_eq!(result, items.len() as i32 + 96);  // line 9 — fails (10 != 99)",
  "    }",
  "}",
].join("\n")

D("defaultRuntimePort — REAL Rust runtime via lldb-dap (second runtime language)", () => {
  test("buildEvidence captures the rust test's locals (the value behind the failure)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtrs-")))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(
      join(dir, "Cargo.toml"),
      ["[package]", 'name = "t"', 'version = "0.1.0"', 'edition = "2021"', "", "[workspace]"].join("\n"),
    )
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
    // SOTA++: the DAP `type` rides along on the captured local (e.g. "int").
    expect((result?.type ?? "").length).toBeGreaterThan(0)
    // SOTA++: per-frame locals are captured — the headline `locals` is the stop
    // frame's, exposed again under `frames[0]` for caller-context drill-down.
    expect(pkt.runtime?.frames?.length ?? 0).toBeGreaterThan(0)
    expect(pkt.runtime?.frames?.[0]?.locals.some((v) => v.name === "result")).toBe(true)
    // T-03 follow-up — Rust PRETTY-PRINTER: with Rust's lldb formatters sourced
    // (initCommands), a `Vec<i32>` surfaces its ELEMENTS as children ([0]=10, …)
    // instead of the raw `{buf,len}` struct. red-on-injection: drop the
    // initCommands and `items` shows RawVec internals, not 10/20/30.
    const items = pkt.runtime?.locals.find((v) => v.name === "items")
    expect(items?.children?.map((c) => c.value)).toEqual(["10", "20", "30"])
  }, 180_000)
})
