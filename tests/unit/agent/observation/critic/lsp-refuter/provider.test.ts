/**
 * HELLGATE RED→green — LSP-backed OwnerRefuter (jul-6 S1). Pins every HARD
 * invariant over a FAKE `LspNavProvider`/`LspNavSession` (no real server, no env).
 *
 * The refuter produces `GraphFacts`; we assert BOTH the raw facts (the exact
 * engine signal) AND the end-to-end verdict via `makeOwnerCritic` (the shipped
 * composition), so `refuted` is proven to require a POSITIVE engine proof.
 */

import { describe, expect, it } from "bun:test"
import { isAbsolute, join } from "node:path"
import type {
  LspNavProvider,
  LspNavSession,
  NavCallHierarchyEntry,
  NavRange,
  NavSymbolInfo,
} from "@/tool/lsp_nav/types"
import type { EditTarget } from "../../../../../../src/agent/observation/critic"
import { lspOwnerRefuter } from "../../../../../../src/agent/observation/critic/lsp-refuter/provider"
import { makeOwnerCritic } from "../../../../../../src/agent/observation/critic/owner-critic"
import type { TaskContext } from "../../../../../../src/agent/observation/port"

const CWD = "/repo/root"
const rng = (l: number): NavRange => ({
  start: { line: l, character: 0 },
  end: { line: l, character: 4 },
})
const sym = (name: string, line = 10): NavSymbolInfo => ({
  name,
  kind: "function",
  range: rng(line),
  selectionRange: rng(line),
})
const caller = (name: string): NavCallHierarchyEntry => ({
  name,
  kind: "function",
  uri: `file://${CWD}/other.py`,
  range: rng(1),
  selectionRange: rng(1),
  fromRanges: [rng(2)],
})

const ctx = (): TaskContext => ({ cwd: CWD, issueText: "", repoFiles: [] })

/** Builds a fake provider from partial session overrides, keyed off the ABSOLUTE
 *  path passed to `open`. `expectAbs` records what path `open` actually received. */
interface FakeOpts {
  session?: Partial<LspNavSession> | null // null ⇒ open returns null (no server)
  onOpen?: (filePath: string) => void
}
const stopCalls: { n: number } = { n: 0 }
const fakeProvider = (opts: FakeOpts): LspNavProvider => ({
  unavailableReason: () => "fake: no server",
  open: async (filePath, _cwd, _signal) => {
    opts.onOpen?.(filePath)
    if (opts.session === null) return null
    const s: LspNavSession = {
      definition: async () => null,
      references: async () => null,
      hover: async () => null,
      typeDefinition: async () => null,
      implementation: async () => null,
      documentSymbol: async () => null,
      workspaceSymbol: async () => null,
      prepareRename: async () => null,
      incomingCalls: async () => null,
      outgoingCalls: async () => null,
      stop: async () => {
        stopCalls.n += 1
      },
      ...(opts.session ?? {}),
    }
    return s
  },
})

describe("lspOwnerRefuter — factory + composition", () => {
  it("composes with makeOwnerCritic into a 3-way OwnerCritic", async () => {
    const refuter = lspOwnerRefuter(CWD, fakeProvider({ session: null }))
    const critic = makeOwnerCritic(refuter)
    const r = await critic.refute({ file: "a.py", symbol: "f" }, ctx())
    // A 3-way verdict, never a boolean.
    expect(["refuted", "not_refuted", "inconclusive"]).toContain(r.verdict)
  })
})

describe("lspOwnerRefuter — REFUTE requires POSITIVE proof (invariant 1)", () => {
  const edited: EditTarget = { file: "pkg/mod.py", symbol: "helper" }

  it("REFUTES: incomingCalls RAN and returned [] on a private helper ⇒ proven-unreachable", async () => {
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: {
          documentSymbol: async () => [sym("helper")],
          incomingCalls: async () => [], // ran, zero callers
        },
      }),
    )
    // Raw engine facts: proven unreachable with full visibility.
    const facts = await refuter.query(edited, ctx())
    expect(facts).not.toBeNull()
    expect(facts?.reachableFromEntrypoints).toBe(false)
    expect(facts?.staticallyComplete).toBe(true)
    // End-to-end verdict.
    const r = await makeOwnerCritic(refuter).refute(edited, ctx())
    expect(r.verdict).toBe("refuted")
  })

  it("does NOT refute when incomingCalls is NULL (no answer ≠ no callers) ⇒ inconclusive", async () => {
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: {
          documentSymbol: async () => [sym("helper")],
          incomingCalls: async () => null, // server ran, no answer / unsupported
        },
      }),
    )
    const facts = await refuter.query(edited, ctx())
    // A null answer is a BLIND SPOT, never a proof: incompleteness, not refuted.
    expect(facts?.staticallyComplete).toBe(false)
    const r = await makeOwnerCritic(refuter).refute(edited, ctx())
    expect(r.verdict).toBe("inconclusive")
  })

  it("does NOT refute a plausible entrypoint even with [] callers (dunder) ⇒ inconclusive", async () => {
    const t: EditTarget = { file: "pkg/mod.py", symbol: "__init__" }
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: {
          documentSymbol: async () => [sym("__init__")],
          incomingCalls: async () => [], // zero STATIC callers, but runtime calls it
        },
      }),
    )
    const r = await makeOwnerCritic(refuter).refute(t, ctx())
    expect(r.verdict).toBe("inconclusive")
  })

  it("does NOT refute a test-case entrypoint with [] callers (runner reflection) ⇒ inconclusive", async () => {
    const t: EditTarget = { file: "tests/t.py", symbol: "test_widget" }
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: {
          documentSymbol: async () => [sym("test_widget")],
          incomingCalls: async () => [],
        },
      }),
    )
    const r = await makeOwnerCritic(refuter).refute(t, ctx())
    expect(r.verdict).toBe("inconclusive")
  })

  it("NOT_REFUTED (never refuted) when callers exist ⇒ reached, no endorsement", async () => {
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: {
          documentSymbol: async () => [sym("helper")],
          incomingCalls: async () => [caller("consumer")],
        },
      }),
    )
    const facts = await refuter.query(edited, ctx())
    expect(facts?.reachableFromEntrypoints).toBe(true)
    expect(facts?.staticallyComplete).toBe(true)
    const r = await makeOwnerCritic(refuter).refute(edited, ctx())
    expect(r.verdict).toBe("not_refuted")
  })
})

describe("lspOwnerRefuter — incompleteness dominates (invariant 2)", () => {
  it("no server (open ⇒ null) ⇒ inconclusive, never refuted", async () => {
    const refuter = lspOwnerRefuter(CWD, fakeProvider({ session: null }))
    const facts = await refuter.query({ file: "a.py", symbol: "f" }, ctx())
    expect(facts?.staticallyComplete).toBe(false)
    const r = await makeOwnerCritic(refuter).refute({ file: "a.py", symbol: "f" }, ctx())
    expect(r.verdict).toBe("inconclusive")
    expect(r.reason).toContain("no language server")
  })

  it("symbol not found in documentSymbol ⇒ null facts ⇒ inconclusive", async () => {
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: {
          documentSymbol: async () => [sym("somethingElse")],
          incomingCalls: async () => [], // would refute IF symbol matched — it must NOT
        },
      }),
    )
    const facts = await refuter.query({ file: "a.py", symbol: "missing" }, ctx())
    expect(facts).toBeNull()
    const r = await makeOwnerCritic(refuter).refute({ file: "a.py", symbol: "missing" }, ctx())
    expect(r.verdict).toBe("inconclusive")
  })

  it("documentSymbol null (server no answer) ⇒ inconclusive", async () => {
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({ session: { documentSymbol: async () => null } }),
    )
    const r = await makeOwnerCritic(refuter).refute({ file: "a.py", symbol: "f" }, ctx())
    expect(r.verdict).toBe("inconclusive")
  })

  it("file-level target (no symbol) ⇒ null facts ⇒ inconclusive (no per-symbol handle)", async () => {
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({ session: { documentSymbol: async () => [sym("f")] } }),
    )
    const facts = await refuter.query({ file: "a.py" }, ctx())
    expect(facts).toBeNull()
  })
})

describe("lspOwnerRefuter — ABSOLUTE path resolution (invariant 3)", () => {
  it("resolves rel→abs via join(cwd, file) before open()", async () => {
    let opened = ""
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: { documentSymbol: async () => [sym("f")], incomingCalls: async () => [] },
        onOpen: (fp) => {
          opened = fp
        },
      }),
    )
    await refuter.query({ file: "pkg/mod.py", symbol: "f" }, ctx())
    expect(isAbsolute(opened)).toBe(true)
    expect(opened).toBe(join(CWD, "pkg/mod.py"))
  })

  it("an already-absolute file is passed through unchanged", async () => {
    let opened = ""
    const abs = join(CWD, "x.py")
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: { documentSymbol: async () => [sym("f")] },
        onOpen: (fp) => {
          opened = fp
        },
      }),
    )
    await refuter.query({ file: abs, symbol: "f" }, ctx())
    expect(opened).toBe(abs)
  })
})

describe("lspOwnerRefuter — time-bounded, never hangs (invariant 4)", () => {
  it("abandons a never-ready open within budget ⇒ inconclusive, returns fast", async () => {
    // Fake open that ONLY settles when the abort signal fires (models a server
    // that never readies). Without a threaded abort budget this would hang.
    const provider: LspNavProvider = {
      unavailableReason: () => "slow",
      open: (_fp, _cwd, signal) =>
        new Promise((resolve) => {
          if (signal?.aborted) return resolve(null)
          signal?.addEventListener("abort", () => resolve(null), { once: true })
        }),
    }
    const started = Date.now()
    const refuter = lspOwnerRefuter(CWD, provider, 40) // 40ms budget
    const r = await makeOwnerCritic(refuter).refute({ file: "a.py", symbol: "f" }, ctx())
    const elapsed = Date.now() - started
    expect(r.verdict).toBe("inconclusive")
    expect(elapsed).toBeLessThan(2_000) // fast — abandoned at budget, not waited out
  })

  it("aborts an in-flight documentSymbol at budget ⇒ inconclusive (timeout)", async () => {
    const provider: LspNavProvider = {
      unavailableReason: () => "slow-symbol",
      open: async () => ({
        definition: async () => null,
        references: async () => null,
        hover: async () => null,
        typeDefinition: async () => null,
        implementation: async () => null,
        documentSymbol: (_fp, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve(null), { once: true })
          }),
        workspaceSymbol: async () => null,
        prepareRename: async () => null,
        incomingCalls: async () => null,
        outgoingCalls: async () => null,
        stop: async () => undefined,
      }),
    }
    const started = Date.now()
    const refuter = lspOwnerRefuter(CWD, provider, 40)
    const r = await makeOwnerCritic(refuter).refute({ file: "a.py", symbol: "f" }, ctx())
    expect(r.verdict).toBe("inconclusive")
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("never throws — a session that throws on incomingCalls ⇒ graceful inconclusive", async () => {
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: {
          documentSymbol: async () => [sym("helper")],
          incomingCalls: async () => {
            throw new Error("boom")
          },
        },
      }),
    )
    const r = await makeOwnerCritic(refuter).refute({ file: "a.py", symbol: "helper" }, ctx())
    expect(r.verdict).toBe("inconclusive")
  })

  it("stops the session even on the refute path (no leak)", async () => {
    stopCalls.n = 0
    const refuter = lspOwnerRefuter(
      CWD,
      fakeProvider({
        session: {
          documentSymbol: async () => [sym("helper")],
          incomingCalls: async () => [],
        },
      }),
    )
    await refuter.query({ file: "a.py", symbol: "helper" }, ctx())
    expect(stopCalls.n).toBe(1)
  })
})
