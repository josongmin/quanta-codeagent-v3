/**
 * Keystone runtime — REAL Rust e2e (lldb-dap). Extends the runtime port to a
 * SECOND language: `cargo test --no-run` builds the test binary, lldb-dap runs
 * it with a breakpoint at the failing test's line, and the captured locals show
 * the value that explains the failure (`result = 10` vs expected 99) — fused
 * into the Evidence Packet's `runtime` section.
 *
 * AUTO-SKIPS without cargo + lldb-dap. Verified 2026-06-10.
 */
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import { detectToolchain, runToolchain } from "@/tool/testrun"
import {
  boundedVersion,
  capabilityGate,
  hasBinary,
  hasLldbDap,
  laneDescribe,
  reportExecuted,
} from "../../../_helpers/capability-lane"

const GROUP = "native-debugger"
const FILE = "tests/unit/tool/evidence/runtime-rust-real-e2e.test.ts"

/**
 * CAPABILITY GROUP `native-debugger`, lane `nightly-heavy`.
 *
 * ubuntu-latest ships NONE of clangd, lldb-dap, dlv or debugpy, so a
 * PR-required arm here would be a permanent visible skip wearing a gate's
 * clothes. The probe no longer shells out: `lldb-dap` lives inside the Xcode /
 * Command Line Tools toolchain on macOS rather than on PATH, and the old
 * fallback was an UNBOUNDED `Bun.spawnSync(["xcrun", "-f", "lldb-dap"])` at
 * module load — a wedged `xcrun` stalled the whole ordinary suite for a file
 * that was going to skip. `hasLldbDap` stats the two known toolchain paths.
 */
const GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { cargo: hasBinary("cargo"), "lldb-dap": hasLldbDap() },
})
const D = laneDescribe(GATE)

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
  afterAll(() =>
    reportExecuted(GATE, GROUP, FILE, "real cargo test binary under lldb-dap", () => ({
      cargoVersion: boundedVersion(["cargo", "--version"]),
      lldbDapVersion: boundedVersion(["lldb-dap", "--version"]),
    })),
  )

  test("buildEvidence captures the rust test's locals (the value behind the failure)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtrs-")))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(
      join(dir, "Cargo.toml"),
      ["[package]", 'name = "t"', 'version = "0.1.0"', 'edition = "2021"', "", "[workspace]"].join(
        "\n",
      ),
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
