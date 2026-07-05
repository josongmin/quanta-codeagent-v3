/**
 * lsp-enrich PROVIDER tests (jul-6). RED-first battery over a FAKE
 * `LspNavProvider`/`LspNavSession` — NO real language server, no env.
 *
 * Pins the HARD invariants:
 *   - documentSymbol ⇒ symbol-refined OwnerHints whose `file` is a candidate.
 *   - hover ⇒ a ContractHint carrying the ACTUAL signature line.
 *   - LSP-unavailable (open ⇒ null for every file) ⇒ produce returns `null`
 *     (graceful no-op — the smoke / no-LSP fallback path).
 *   - NO numeric confidence (ordinal EvidenceStrength only).
 *   - Owners' `file` is ALWAYS one of candidateFiles (never an invented path,
 *     even if the fake session hands back a symbol tagged with a foreign uri).
 *   - budget-bounded (maxOwners), never throws (dead server / abort / parse
 *     miss ⇒ graceful skip).
 */

import { describe, expect, it } from "bun:test"
import type { EvidenceStrength } from "@/agent/observation/fragment"
import type { ProviderBudget, TaskContext } from "@/agent/observation/port"
import { lspEnrichProvider } from "@/agent/observation/providers/lsp-enrich/provider"
import type { LspNavProvider, LspNavSession, NavHover, NavPos, NavSymbolInfo } from "@/tool"

/* ----------------------------------------------------------------------- *
 * Fake LSP seam. Every method is null-safe and configurable per-file so a
 * test can flip symbols/hover and assert red-on-injection.
 * ----------------------------------------------------------------------- */

interface FakeFile {
  /** null ⇒ open() returns null (no server for this file). */
  readonly symbols: NavSymbolInfo[] | null
  /** hover keyed by "line:character"; missing ⇒ null (no hover here). */
  readonly hovers?: Record<string, NavHover>
  /** if set, session methods throw this to prove never-throws. */
  readonly throwOn?: "documentSymbol" | "hover"
}

const sym = (
  name: string,
  kind: NavSymbolInfo["kind"],
  line = 0,
  character = 0,
  uri?: string,
): NavSymbolInfo => ({
  name,
  kind,
  range: { start: { line, character }, end: { line, character: character + 1 } },
  selectionRange: { start: { line, character }, end: { line, character: character + 1 } },
  ...(uri !== undefined ? { uri } : {}),
})

const fakeProvider = (files: Record<string, FakeFile>): LspNavProvider => ({
  unavailableReason: () => "fake: no server",
  open: async (filePath): Promise<LspNavSession | null> => {
    const cfg = files[filePath]
    if (cfg === undefined || cfg.symbols === null) return null
    const session: LspNavSession = {
      documentSymbol: async () => {
        if (cfg.throwOn === "documentSymbol") throw new Error("boom")
        return cfg.symbols
      },
      hover: async (_file: string, pos: NavPos): Promise<NavHover | null> => {
        if (cfg.throwOn === "hover") throw new Error("boom")
        const key = `${pos.line}:${pos.character}`
        return cfg.hovers?.[key] ?? null
      },
      definition: async () => null,
      references: async () => null,
      typeDefinition: async () => null,
      implementation: async () => null,
      workspaceSymbol: async () => null,
      prepareRename: async () => null,
      incomingCalls: async () => null,
      outgoingCalls: async () => null,
      stop: async () => undefined,
    }
    return session
  },
})

const ctx = (over: Partial<TaskContext> = {}): TaskContext => ({
  cwd: "/repo",
  issueText: "something is broken",
  repoFiles: ["a.py", "b.py"],
  capability: "source-repair",
  ...over,
})

const budget: ProviderBudget = { maxMillis: 5_000, maxOwners: 8 }

describe("lspEnrichProvider — applicable gate", () => {
  it("is applicable when capability != vision and there are candidate files", () => {
    const p = lspEnrichProvider(["a.py"], "/repo", fakeProvider({}))
    expect(p.applicable(ctx({ capability: "source-repair" }))).toBe(true)
    expect(p.applicable(ctx({ capability: "general" }))).toBe(true)
  })

  it("is NOT applicable for a vision task", () => {
    const p = lspEnrichProvider(["a.py"], "/repo", fakeProvider({}))
    expect(p.applicable(ctx({ capability: "vision" }))).toBe(false)
  })

  it("is NOT applicable with zero candidate files", () => {
    const p = lspEnrichProvider([], "/repo", fakeProvider({}))
    expect(p.applicable(ctx())).toBe(false)
  })

  it("declares kind localization and id lsp-prefetch", () => {
    const p = lspEnrichProvider(["a.py"], "/repo", fakeProvider({}))
    expect(p.kind).toBe("localization")
    expect(p.id).toBe("lsp-prefetch")
  })
})

describe("lspEnrichProvider — documentSymbol harvest", () => {
  it("emits symbol-refined OwnerHints from documentSymbol", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({ "a.py": { symbols: [sym("handle_request", "function", 3, 4)] } }),
    )
    const frag = await p.produce(ctx(), budget)
    expect(frag).not.toBeNull()
    const owner = frag?.owners?.[0]
    expect(owner?.file).toBe("a.py")
    expect(owner?.symbol).toBe("handle_request")
    expect(owner?.source).toBe("lsp-prefetch")
    // evidence reflects the ACTUAL harvested fact (kind + name), not a template.
    expect(owner?.evidence).toContain("handle_request")
    expect(owner?.evidence).toContain("function")
  })

  it("prefers function/method/class symbols over variables/fields", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({
        "a.py": {
          symbols: [
            sym("SOME_CONST", "constant", 0, 0),
            sym("MyClass", "class", 5, 0),
            sym("tmp", "variable", 6, 0),
          ],
        },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    const names = frag?.owners?.map((o) => o.symbol)
    expect(names).toContain("MyClass")
    // a pure variable/constant is not promoted to an owner symbol.
    expect(names).not.toContain("tmp")
    expect(names).not.toContain("SOME_CONST")
  })

  it("harvests across multiple candidate files", async () => {
    const p = lspEnrichProvider(
      ["a.py", "b.py"],
      "/repo",
      fakeProvider({
        "a.py": { symbols: [sym("fa", "function")] },
        "b.py": { symbols: [sym("fb", "function")] },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    const files = frag?.owners?.map((o) => o.file)
    expect(files).toContain("a.py")
    expect(files).toContain("b.py")
  })
})

describe("lspEnrichProvider — hover ⇒ ContractHint", () => {
  it("emits a ContractHint carrying the hover signature line", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({
        "a.py": {
          symbols: [sym("handle", "function", 2, 4)],
          hovers: { "2:4": { contents: "def handle(req: Request) -> Response" } },
        },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    const contract = frag?.contracts?.[0]
    expect(contract).toBeDefined()
    // signature reflects the ACTUAL hover, not a placeholder.
    expect(contract?.signature).toContain("handle(req: Request)")
  })

  it("strips a leading markdown code-fence, keeping the real signature line", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({
        "a.py": {
          symbols: [sym("handle", "function", 2, 4)],
          hovers: { "2:4": { contents: "```python\ndef handle(x: int) -> int\n```" } },
        },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    const sig = frag?.contracts?.[0]?.signature
    expect(sig).toBe("def handle(x: int) -> int")
    expect(sig).not.toContain("```")
  })

  it("omits contracts when no hover is parseable (no fabricated signature)", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({ "a.py": { symbols: [sym("handle", "function", 2, 4)] } }),
    )
    const frag = await p.produce(ctx(), budget)
    expect(frag?.contracts ?? []).toHaveLength(0)
    // but the owner still shipped.
    expect(frag?.owners?.length).toBeGreaterThan(0)
  })
})

describe("lspEnrichProvider — graceful degradation (all servers null ⇒ null)", () => {
  it("returns null when open() is null for EVERY candidate file", async () => {
    const p = lspEnrichProvider(
      ["a.py", "b.py"],
      "/repo",
      fakeProvider({ "a.py": { symbols: null }, "b.py": { symbols: null } }),
    )
    const frag = await p.produce(ctx(), budget)
    // MUST be null (not an empty-owners fragment) so the pipeline falls back to
    // agentless-only.
    expect(frag).toBeNull()
  })

  it("returns null when servers open but yield NO symbols anywhere", async () => {
    const p = lspEnrichProvider(["a.py"], "/repo", fakeProvider({ "a.py": { symbols: [] } }))
    const frag = await p.produce(ctx(), budget)
    expect(frag).toBeNull()
  })

  it("skips only the null-server file, still harvests the reachable one", async () => {
    const p = lspEnrichProvider(
      ["a.py", "b.py"],
      "/repo",
      fakeProvider({
        "a.py": { symbols: null },
        "b.py": { symbols: [sym("fb", "function")] },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    expect(frag?.owners?.map((o) => o.file)).toEqual(["b.py"])
  })
})

describe("lspEnrichProvider — hallucination fence + no numeric confidence", () => {
  it("NEVER emits an owner whose file is not a candidate", async () => {
    // symbols carry a foreign uri; provider must still key the owner off the
    // opened candidate file, never the symbol's uri.
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({
        "a.py": { symbols: [sym("f", "function", 0, 0, "file:///etc/passwd")] },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    for (const o of frag?.owners ?? []) {
      expect(["a.py", "b.py"]).toContain(o.file)
    }
    expect(frag?.owners?.[0]?.file).toBe("a.py")
  })

  it("drops a nameless symbol (no data-free evidence / empty symbol owner)", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({
        "a.py": { symbols: [sym("", "function", 0, 0), sym("real", "function", 1, 0)] },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    const names = frag?.owners?.map((o) => o.symbol)
    expect(names).toEqual(["real"])
    for (const o of frag?.owners ?? []) {
      expect(o.evidence.trim()).not.toBe("lsp: function")
    }
  })

  it("strength is an ordinal EvidenceStrength, never a number", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({ "a.py": { symbols: [sym("f", "function")] } }),
    )
    const frag = await p.produce(ctx(), budget)
    const allowed: EvidenceStrength[] = ["high", "medium", "low", "unknown"]
    for (const o of frag?.owners ?? []) {
      if (o.strength !== undefined) {
        expect(allowed).toContain(o.strength)
        expect(typeof o.strength).toBe("string")
      }
    }
  })

  it("does NOT ship strength=high off a symbol with no hover evidence (overtrust)", async () => {
    // A bare documentSymbol (no hover contract) must not be labeled high.
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({ "a.py": { symbols: [sym("f", "function")] } }),
    )
    const frag = await p.produce(ctx(), budget)
    expect(frag?.owners?.[0]?.strength).not.toBe("high")
  })
})

describe("lspEnrichProvider — budget + never-throws", () => {
  it("caps owners at budget.maxOwners", async () => {
    const many = Array.from({ length: 10 }, (_, i) => sym(`f${i}`, "function", i, 0))
    const p = lspEnrichProvider(["a.py"], "/repo", fakeProvider({ "a.py": { symbols: many } }))
    const frag = await p.produce(ctx(), { maxMillis: 5_000, maxOwners: 3 })
    expect(frag?.owners?.length).toBeLessThanOrEqual(3)
  })

  it("returns null (no throw) when maxOwners is non-positive", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({ "a.py": { symbols: [sym("f", "function")] } }),
    )
    const frag = await p.produce(ctx(), { maxMillis: 5_000, maxOwners: 0 })
    expect(frag).toBeNull()
  })

  it("does not throw when documentSymbol throws (graceful skip)", async () => {
    const p = lspEnrichProvider(
      ["a.py", "b.py"],
      "/repo",
      fakeProvider({
        "a.py": { symbols: [sym("fa", "function")], throwOn: "documentSymbol" },
        "b.py": { symbols: [sym("fb", "function")] },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    // a.py's throw is swallowed; b.py still harvested.
    expect(frag?.owners?.map((o) => o.file)).toEqual(["b.py"])
  })

  it("does not throw when hover throws — owner survives, contract skipped", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({
        "a.py": { symbols: [sym("f", "function", 1, 0)], throwOn: "hover" },
      }),
    )
    const frag = await p.produce(ctx(), budget)
    expect(frag?.owners?.length).toBeGreaterThan(0)
    expect(frag?.contracts ?? []).toHaveLength(0)
  })

  it("returns null (no throw) when the budget clock is already exhausted", async () => {
    const p = lspEnrichProvider(
      ["a.py"],
      "/repo",
      fakeProvider({ "a.py": { symbols: [sym("f", "function")] } }),
    )
    const frag = await p.produce(ctx(), { maxMillis: 0, maxOwners: 8 })
    expect(frag).toBeNull()
  })
})
