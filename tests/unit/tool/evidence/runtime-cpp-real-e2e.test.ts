/**
 * T-04 — REAL C++ e2e (Tier-2, toolchain-verified). The 5th language: clang++
 * `-g` compiles the failing source standalone, lldb-dap (same adapter as Rust)
 * stops at the assertion line, and the local explaining the failure
 * (`result = 10` vs expected 99) is captured — same Evidence shape. Plus the
 * STATIC half via real clangd (type/hover at the failure site).
 *
 * AUTO-SKIPS without clang++ / lldb-dap / clangd. Verified 2026-06-10.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import type { Toolchain } from "@/tool/testrun"

const has = (b: string, ...a: string[]): boolean => {
  try {
    return Bun.spawnSync([b, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const lldbDap = (): boolean => {
  if (has("lldb-dap", "--help")) return true
  try {
    const r = Bun.spawnSync(["xcrun", "-f", "lldb-dap"], { stdout: "pipe", stderr: "ignore" })
    return r.exitCode === 0 && r.stdout.toString().trim().length > 0
  } catch {
    return false
  }
}
const cxx = (): boolean => has("clang++", "--version") || has("g++", "--version")

const SRC = [
  "#include <cassert>",
  "int compute(int n) { int total = 0; for (int i = 0; i < n; i++) total += i; return total; }",
  "int main() {",
  "  int result = compute(5);",
  "  assert(result == 99); // line 5 — fails, result=10",
  "  return 0;",
  "}",
  "",
].join("\n")

const writeCpp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtcpp-")))
  writeFileSync(join(dir, "t.cpp"), SRC)
  return dir
}

const DRUN = cxx() && lldbDap() ? describe : describe.skip
DRUN("defaultRuntimePort — REAL C++ runtime (clang++ -g → lldb-dap)", () => {
  test("compiles + captures the failing assert's local over DAP", async () => {
    const dir = writeCpp()
    const tc: Toolchain = { kind: "cpp", command: ["true"], parser: "ctest" } // failure run stubbed; we test runtime
    const pkt = await buildEvidence(dir, {
      detect: async () => tc,
      // Synthesize the failure (the runtime is keyed off file+line; the ctest
      // parser path is unit-tested separately).
      runTests: async () => ({
        runner: "ctest",
        passed: 0,
        failed: [{ name: "main", file: join(dir, "t.cpp"), line: 5, message: "assert" }],
        ok: false,
      }),
      runtime: defaultRuntimePort,
      changedFiles: async () => ["t.cpp"],
    })
    expect(pkt.language).toBe("cpp")
    expect(pkt.runtime).not.toBeNull()
    expect(pkt.runtime?.locals.find((v) => v.name === "result")?.value).toBe("10")
  }, 60_000)
})

const DSTATIC = has("clangd", "--version") ? describe : describe.skip
DSTATIC("evidenceLspStatic — REAL clangd (Tier-2 C++ static)", () => {
  test("returns hover/type info at the C++ failure site", async () => {
    const dir = writeCpp()
    const ev = await evidenceLspStatic()(join(dir, "t.cpp"), 5, dir)
    expect(ev).not.toBeNull()
    expect((ev?.type_info ?? "").length).toBeGreaterThan(0)
  }, 90_000)
})
