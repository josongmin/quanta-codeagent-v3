// Hellgate — LSP-nav server-present resource gate (jun-26).
//
// Audit fix #1 (tool-surface SOTA): the read-only LSP-nav tools are the biggest
// code-navigation moat versus competitors (Cursor/Codex expose none), yet they
// used to register ONLY behind the obscure `QUANTA_LSP_TOOLS=full`, so they were
// invisible by default. This pins the new policy:
//   - read-only nav auto-registers on CLI when a language server is on PATH
//     (server-present resource gate — never a dead tool in a no-LSP env);
//   - the MUTATING members (rename_apply / format) NEVER auto-on — `=full` only;
//   - an explicit OFF token keeps the legacy byte-identical (empty) surface;
//   - the change does NOT widen the CLI default-ON env seed (resource gates are
//     not seeded), so bench/web stay byte-identical.

import { describe, expect, test } from "bun:test"
import { lspNavToolList } from "@/agent"
import { resolveLspNavMode } from "@/apps/cli/internal/argv"
import { anyLspServerOnPath, LSP_SERVER_BINS } from "@/lsp"
import { GATED_TOOLS, seedEnvVarsForSurface } from "@/tool"

describe("resolveLspNavMode — CLI policy", () => {
  test("explicit `full` ⇒ all (read-only + mutating), regardless of server", () => {
    expect(resolveLspNavMode("full", false)).toBe("all")
    expect(resolveLspNavMode("full", true)).toBe("all")
    expect(resolveLspNavMode(" FULL ", true)).toBe("all") // trimmed + case-insensitive
  })

  test("explicit OFF token ⇒ none (kill-switch wins even with a server installed)", () => {
    for (const off of ["0", "off", "false", "no", "OFF"]) {
      expect(resolveLspNavMode(off, true)).toBe("none")
    }
  })

  test("unset ⇒ AUTO: readonly iff a server is present, else none", () => {
    expect(resolveLspNavMode(undefined, true)).toBe("readonly")
    expect(resolveLspNavMode(undefined, false)).toBe("none")
  })

  test("truthy-but-not-`full` ⇒ AUTO readonly (never silently the mutating surface)", () => {
    expect(resolveLspNavMode("1", true)).toBe("readonly")
    expect(resolveLspNavMode("on", true)).toBe("readonly")
    expect(resolveLspNavMode("1", false)).toBe("none")
  })
})

describe("anyLspServerOnPath — server-present detection", () => {
  test("true iff at least one known server bin resolves", () => {
    expect(anyLspServerOnPath(() => false)).toBe(false)
    expect(anyLspServerOnPath(() => true)).toBe(true)
    // only a NON-registry bin present ⇒ false (must be a known server)
    expect(anyLspServerOnPath((bin) => bin === "totally-not-a-langserver")).toBe(false)
    // exactly one known bin present ⇒ true
    const one = LSP_SERVER_BINS[0] as string
    expect(anyLspServerOnPath((bin) => bin === one)).toBe(true)
  })
})

describe("read-only subset (the `readonly` mode wire) excludes mutating members", () => {
  // The wire registers `lspNavToolList().filter(t => t.isReadOnly())` in readonly
  // mode. Pin that the filter keeps nav and drops the two mutating tools.
  const ro = lspNavToolList().filter((t) => t.isReadOnly())
  const roNames = new Set(ro.map((t) => t.name))

  test("read-only subset INCLUDES core nav", () => {
    expect(roNames.has("lsp_references")).toBe(true)
    expect(roNames.has("lsp_definition")).toBe(true)
  })

  test("read-only subset EXCLUDES the mutating members (never auto-on)", () => {
    expect(roNames.has("lsp_rename_apply")).toBe(false)
    expect(roNames.has("lsp_format")).toBe(false)
  })

  test("the full list DOES carry the mutating members (so `=full` exposes them)", () => {
    const all = new Set(lspNavToolList().map((t) => t.name))
    expect(all.has("lsp_rename_apply")).toBe(true)
    expect(all.has("lsp_format")).toBe(true)
  })
})

describe("manifest split — read-only resource-gated, mutating opt-in", () => {
  const entry = (name: string) => {
    const e = GATED_TOOLS.find((x) => x.name === name)
    if (e === undefined) throw new Error(`manifest has no entry "${name}"`)
    return e
  }

  test("lsp_references row is a CLI-default resource gate, risk read-only", () => {
    const e = entry("lsp_references")
    expect(e.gate.kind).toBe("resource")
    expect(e.default.cli).toBe("resource")
    expect(e.risk).toBe("read-only")
    // the mutating members are NOT in this row
    expect(e.group).not.toContain("lsp_rename_apply")
    expect(e.group).not.toContain("lsp_format")
  })

  test("lsp_rename_apply row is an opt-in env-flag gate, risk mutating", () => {
    const e = entry("lsp_rename_apply")
    expect(e.gate.kind).toBe("env-flag")
    expect(e.default.cli).toBe("opt-in")
    expect(e.risk).toBe("mutating")
    expect(e.group).toContain("lsp_format")
  })

  test("the split does NOT widen the CLI default-ON env seed (byte-identical seed)", () => {
    // resource gates are not seeded; QUANTA_LSP_TOOLS must stay OUT of the seed
    // set so unset CLI envs are unchanged and bench/web stay byte-identical.
    expect([...seedEnvVarsForSurface("cli")]).not.toContain("QUANTA_LSP_TOOLS")
    expect(seedEnvVarsForSurface("bench")).toEqual([])
  })
})
