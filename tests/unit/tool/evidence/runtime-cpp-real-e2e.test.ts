/**
 * T-04 — REAL C++ e2e (Tier-2, toolchain-verified). The 5th language: clang++
 * `-g` compiles the failing source standalone, lldb-dap (same adapter as Rust)
 * stops at the assertion line, and the local explaining the failure
 * (`result = 10` vs expected 99) is captured — same Evidence shape. Plus the
 * STATIC half via real clangd (type/hover at the failure site).
 *
 * AUTO-SKIPS without clang++ / lldb-dap / clangd. Verified 2026-06-10.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { defaultRuntimePort } from "@/tool/evidence"
import { buildEvidence } from "@/tool/evidence/builder"
import type { Toolchain } from "@/tool/testrun"
import {
  boundedVersion,
  capabilityGate,
  hasBinary,
  hasLldbDap,
  laneDescribe,
  reportExecuted,
} from "../../../_helpers/capability-lane"

const GROUP = "native-debugger"
const FILE = "tests/unit/tool/evidence/runtime-cpp-real-e2e.test.ts"

/**
 * CAPABILITY GROUP `native-debugger`, lane `nightly-heavy`.
 *
 * The lldb-dap probe was an UNBOUNDED `Bun.spawnSync(["xcrun","-f","lldb-dap"])`
 * at module load; `hasLldbDap` stats the Xcode / CLT toolchain paths instead, so
 * an ordinary run that skips this file spawns nothing at all.
 */
const cxxPresent = hasBinary("clang++") || hasBinary("g++")
const RUNTIME_GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { "clang++/g++": cxxPresent, "lldb-dap": hasLldbDap() },
})
const DRUN = laneDescribe(RUNTIME_GATE)

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

DRUN("defaultRuntimePort — REAL C++ runtime (clang++ -g → lldb-dap)", () => {
  afterAll(() =>
    reportExecuted(
      RUNTIME_GATE,
      GROUP,
      FILE,
      "real clang++ -g binary stopped under lldb-dap",
      () => ({
        clangVersion: boundedVersion(["clang++", "--version"]),
        lldbDapVersion: boundedVersion(["lldb-dap", "--version"]),
      }),
    ),
  )

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

const STATIC_GATE = capabilityGate({
  group: GROUP,
  file: FILE,
  needs: { clangd: hasBinary("clangd") },
})
const DSTATIC = laneDescribe(STATIC_GATE)
DSTATIC("evidenceLspStatic — REAL clangd (Tier-2 C++ static)", () => {
  afterAll(() =>
    reportExecuted(
      STATIC_GATE,
      GROUP,
      FILE,
      "real clangd answered hover at the C++ failure site",
      () => ({
        clangVersion: boundedVersion(["clangd", "--version"]),
      }),
    ),
  )

  test("returns hover/type info at the C++ failure site", async () => {
    const dir = writeCpp()
    const ev = await evidenceLspStatic()(join(dir, "t.cpp"), 5, dir)
    expect(ev).not.toBeNull()
    expect((ev?.type_info ?? "").length).toBeGreaterThan(0)
  }, 90_000)
})
