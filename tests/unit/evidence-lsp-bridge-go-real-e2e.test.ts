/**
 * Keystone enrichment bridge — REAL e2e for the PRODUCTION `evidenceLspStatic()`
 * port on GO (gopls). Proves the `.go` → GoplsAdapter wiring added to
 * `lsp-bridge` actually drives a real gopls server at a failure site and fuses
 * the hover/type info into a real buildEvidence packet — closing the Go static
 * gap (Go already had failure + DAP runtime; this gives it static parity with
 * Python/Rust). AUTO-SKIPS without `go` + `gopls`. Verified 2026-06-10.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { gateOn } from "@/shared"
import { buildEvidence } from "@/tool/evidence/builder"
import { detectToolchain, runToolchain } from "@/tool/testrun"

const has = (b: string, ...a: string[]): boolean => {
  try {
    return Bun.spawnSync([b, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
// gopls has no `--version` flag (it errors), but `gopls version` is the probe.
// SOTA ① — real-on-demand lane (see evidence-lsp-bridge-real-e2e.test.ts): real
// gopls thunders under the parallel suite, so this runs only when
// QUANTA_REAL_TOOLCHAIN_E2E is set (`bun run test:real-toolchain`, serial).
const D =
  gateOn(process.env, "QUANTA_REAL_TOOLCHAIN_E2E") &&
  has("go", "version") &&
  has("gopls", "version")
    ? describe
    : describe.skip

const project = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "evbridge-go-")))
  writeFileSync(join(dir, "go.mod"), ["module t", "", "go 1.21"].join("\n"))
  writeFileSync(
    join(dir, "add.go"),
    ["package t", "", "func Add(a, b int) int {", "\treturn a + b", "}"].join("\n"),
  )
  writeFileSync(
    join(dir, "add_test.go"),
    [
      "package t",
      "",
      'import "testing"',
      "",
      "func TestAdd(t *testing.T) {",
      "\tif Add(2, 2) != 5 { // line 6 — the failing assertion site",
      '\t\tt.Fatalf("got %d", Add(2, 2))',
      "\t}",
      "}",
    ].join("\n"),
  )
  return dir
}

D("evidenceLspStatic — PRODUCTION LSP static port (real gopls)", () => {
  test("queries the real gopls server at a Go failure site and returns StaticEvidence", async () => {
    const dir = project()
    const port = evidenceLspStatic()
    // Failure is at add_test.go:6 (the `if Add(2,2) != 5` line). The column scan
    // lands on a real symbol (Add / the comparison); assert non-empty hover.
    const ev = await port(join(dir, "add_test.go"), 6, dir)
    expect(ev).not.toBeNull()
    expect((ev?.type_info ?? "").length).toBeGreaterThan(0)
  }, 90_000)

  test("buildEvidence fuses a real `go test` failure + real gopls static", async () => {
    const dir = project()
    const pkt = await buildEvidence(dir, {
      detect: (c) => detectToolchain(c, { fileExists: async (n) => existsSync(join(c, n)) }),
      runTests: (tc, c) => runToolchain(tc, c),
      lspStatic: evidenceLspStatic(),
      changedFiles: async () => ["add.go"],
    })
    expect(pkt.language).toBe("go")
    expect(pkt.failure?.test_name).toContain("TestAdd")
    expect(pkt.static).not.toBeNull()
    expect((pkt.static?.type_info ?? "").length).toBeGreaterThan(0) // real gopls hover fused in
  }, 120_000)
})
