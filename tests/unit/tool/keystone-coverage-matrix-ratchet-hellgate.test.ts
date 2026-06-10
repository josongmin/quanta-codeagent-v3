/**
 * T-05 — Keystone coverage-matrix DRIFT RATCHET. The multilang-debug keystone's
 * DoD §1 is a 4-language × 3-axis matrix (failure / static / runtime). This test
 * pins each cell against an INDEPENDENT literal expectation (NOT re-derived from
 * the source's own tables — that would be tautological) so a refactor that drops
 * a language from any axis goes RED here.
 *
 * - failure axis: detectToolchain(marker) → {kind, parser}.
 * - static  axis: lspExtensionToLanguage().get(ext) → server bin.
 * - runtime axis: defaultRuntimePort dispatches each kind (DAP or CDP carrier);
 *   the exhaustive Record over `Toolchain["kind"]` is a COMPILE-TIME guard (add a
 *   kind ⇒ tsc forces a row; remove one ⇒ the extra key errors).
 */
import { describe, expect, test } from "bun:test"
import { lspExtensionToLanguage } from "@/agent/lsp-bridge"
import { defaultRuntimePort } from "@/tool/evidence"
import { detectToolchain, type Toolchain } from "@/tool/testrun"

const fsWith = (present: string[], pytest = false) => ({
  fileExists: async (n: string) => present.includes(n),
  canRun: async (cmd: readonly string[]) => pytest && cmd.includes("pytest"),
})

describe("keystone coverage matrix — drift ratchet (DoD §1)", () => {
  test("FAILURE axis: each language marker detects its {kind, parser}", async () => {
    expect(await detectToolchain("/p", fsWith(["go.mod"]))).toMatchObject({ kind: "go", parser: "go" })
    expect(await detectToolchain("/p", fsWith(["Cargo.toml"]))).toMatchObject({ kind: "rust", parser: "cargo" })
    expect(await detectToolchain("/p", fsWith(["package.json"]))).toMatchObject({ kind: "node", parser: "node" })
    // python: unittest by default, pytest when installed (canRun probe true).
    expect(await detectToolchain("/p", fsWith(["pyproject.toml"]))).toMatchObject({ kind: "python", parser: "python-unittest" })
    expect(await detectToolchain("/p", fsWith(["pyproject.toml"], true))).toMatchObject({ kind: "python", parser: "pytest" })
  })

  test("STATIC axis: each language extension maps to its LSP server", () => {
    const m = lspExtensionToLanguage()
    expect(m.get(".py")).toBe("pyright-langserver")
    expect(m.get(".ts")).toBe("typescript-language-server")
    expect(m.get(".rs")).toBe("rust-analyzer")
    expect(m.get(".go")).toBe("gopls")
  })

  test("RUNTIME axis: every toolchain kind has a debugger carrier (exhaustive)", async () => {
    // Compile-time exhaustiveness: a Record keyed by the FULL `Toolchain["kind"]`
    // union — adding/removing a kind breaks this literal at tsc time.
    const carriers: Record<Toolchain["kind"], "DAP" | "CDP"> = {
      python: "DAP", // debugpy
      rust: "DAP", // lldb-dap
      go: "DAP", // dlv-dap over TCP
      node: "CDP", // node --inspect-brk
    }
    expect(Object.keys(carriers).sort()).toEqual(["go", "node", "python", "rust"])
    // Behavioural: defaultRuntimePort handles every kind WITHOUT throwing — it
    // degrades to null when the failure has no file/line OR the tool is absent,
    // never crashes on an unrecognized kind.
    for (const kind of Object.keys(carriers) as Toolchain["kind"][]) {
      const tc: Toolchain = { kind, command: [], parser: "generic" }
      const r = await defaultRuntimePort({ command: "x", test_name: "t" }, tc, "/nonexistent-cwd-xyz")
      expect(r).toBeNull() // no file/line ⇒ graceful null (not a throw)
    }
  })
})
