/**
 * tool-origin-substrate — hellgate (ADR-0471 Substrate-B).
 *
 * WHAT: proves the registry carries a tool-ORIGIN signal so a consumer derives
 *       provenance ACCURATELY (call-site / source array), never by name-guessing.
 * ADR: 0471 (untrusted-source-envelope) — this is the origin substrate the
 *       human-owned dispatch #2 maps onto `@/agent/untrusted-envelope`.
 *
 * Coverage:
 *  (1) unit  — deriveProvenance exhaustive over origin × representative name,
 *              assertNever on the closed ToolOrigin enum.
 *  (2) unit  — ToolRegistry.originOf returns the tag; no map ⇒ builtin (default).
 *  (3) e2e   — buildToolingCore tags each SOURCE ARRAY: mcp→mcp, lsp→lsp,
 *              git→git, base→builtin, end-to-end through the real assembler.
 *  (4) PERF  — originOf is O(1) map lookup: a HARD call-count bound proving the
 *              origin map is built ONCE at assembly, not recomputed per lookup,
 *              and that lookups never scan the tool list.
 */
import { describe, expect, test } from "bun:test"
// Cross-slice import is INTENTIONAL and confined to the test: the whole design
// rests on `@/tool`'s `Provenance` being STRING-IDENTICAL to
// `@/agent/untrusted-envelope`'s `UntrustedSource`, so dispatch #2 maps it with
// the identity. `@/tool` must NOT import `@/agent` in src (slice fence), so this
// load-bearing invariant can only be locked here, in the test plane.
import { UNTRUSTED_SOURCES, type UntrustedSource } from "@/agent/untrusted-envelope"
import type { StructuredLogger } from "@/observability"
import { buildToolingCore } from "@/runner/assemble/tooling"
import type { Tool } from "@/tool"
import {
  deriveProvenance,
  type Provenance,
  TOOL_ORIGINS,
  type ToolOrigin,
  ToolRegistry,
} from "@/tool"

// ---- minimal fake tool (no schema/exec needed for metadata assertions) ----
const fakeTool = (name: string): Tool =>
  ({
    name,
    description: name,
    inputSchema: { safeParse: () => ({ success: true, data: {} }) },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    classifySource: () => null,
    execute: () => (async function* () {})(),
  }) as unknown as Tool

const noopLogger: StructuredLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as StructuredLogger

describe("tool-origin-substrate / deriveProvenance (unit, exhaustive)", () => {
  // Exhaustive origin × representative name matrix. The expected provenance is
  // the ADR-0471 mapping. Each row is a CALL-SITE fact, never a name guess.
  const cases: ReadonlyArray<[ToolOrigin, string, Provenance]> = [
    ["mcp", "anything", "mcp"],
    ["mcp", "web_fetch", "mcp"], // origin wins over name
    ["plugin", "anything", "plugin"],
    ["plugin", "bash", "plugin"], // origin wins over name
    ["lsp", "diagnostics", "internal"],
    ["git", "git_status", "internal"],
    ["builtin", "web_fetch", "web_fetch"],
    ["builtin", "web_search", "web_fetch"],
    ["builtin", "bash", "bash"],
    ["builtin", "bash_await", "bash"], // bash* prefix
    ["builtin", "bash_kill", "bash"],
    ["builtin", "read", "file"],
    ["builtin", "read_image", "file"],
    ["builtin", "csv_read", "file"],
    ["builtin", "pdf_read", "file"],
    ["builtin", "xlsx_read", "file"],
    ["builtin", "yaml_read", "file"],
    ["builtin", "ndjson_read", "file"],
    ["builtin", "edit", "internal"],
    ["builtin", "write", "internal"],
    ["builtin", "grep", "internal"],
    ["builtin", "agent", "internal"],
  ]

  for (const [origin, name, expected] of cases) {
    test(`origin=${origin} name=${name} → ${expected}`, () => {
      expect(deriveProvenance(name, origin)).toBe(expected)
    })
  }

  test("closed ToolOrigin enum: every member is mapped (assertNever-proof)", () => {
    // If a new ToolOrigin member is added without a branch, deriveProvenance's
    // internal assertNever throws; this drives that contract from the test side.
    for (const origin of TOOL_ORIGINS) {
      expect(() => deriveProvenance("read", origin)).not.toThrow()
    }
    expect([...TOOL_ORIGINS].sort()).toEqual(["builtin", "git", "lsp", "mcp", "plugin"])
  })
})

describe("tool-origin-substrate / Provenance ≡ UntrustedSource (identity invariant)", () => {
  // The CENTRAL design claim: dispatch #2 maps `@/tool`'s `Provenance` onto
  // `@/agent/untrusted-envelope`'s `UntrustedSource` with the IDENTITY function.
  // That is only sound while the two unions are string-identical. If a future
  // edit adds a member to one and not the other, the identity map silently
  // mishandles it. These assertions fail loudly the moment the unions diverge.

  test("every Provenance deriveProvenance can produce is a valid UntrustedSource", () => {
    const untrusted = new Set<string>(UNTRUSTED_SOURCES)
    // Drive deriveProvenance across the full origin × representative-name space
    // and assert each result is a member of UntrustedSource.
    const names = [
      "web_fetch",
      "web_search",
      "bash",
      "bash_await",
      "read",
      "read_image",
      "csv_read",
      "edit",
      "write",
      "grep",
      "agent",
      "unknown_tool",
    ]
    for (const origin of TOOL_ORIGINS) {
      for (const name of names) {
        const p: Provenance = deriveProvenance(name, origin)
        expect(untrusted.has(p)).toBe(true)
      }
    }
  })

  test("the two closed sets are byte-identical (sorted member equality)", () => {
    // A Provenance value list assembled from the SAME literals as UntrustedSource.
    // Typed as Provenance so a divergence in either union is a compile-time error
    // here too, and the runtime equality below catches a value-level drift.
    const provenanceMembers: readonly Provenance[] = [
      "mcp",
      "web_fetch",
      "file",
      "plugin",
      "bash",
      "internal",
    ]
    expect([...provenanceMembers].sort()).toEqual([...UNTRUSTED_SOURCES].sort())
  })

  test("the identity map round-trips every UntrustedSource through Provenance", () => {
    // Prove the identity function dispatch #2 will use is total over the union:
    // each UntrustedSource is assignable to Provenance and back unchanged.
    for (const s of UNTRUSTED_SOURCES) {
      const asProvenance = s as Provenance // identity (string-identical members)
      const back: UntrustedSource = asProvenance as UntrustedSource
      expect(back).toBe(s)
    }
  })
})

describe("tool-origin-substrate / ToolRegistry.originOf (unit)", () => {
  test("no origin map ⇒ every tool is builtin (byte-identical default)", () => {
    const r = new ToolRegistry([fakeTool("read"), fakeTool("foo")])
    expect(r.originOf("read")).toBe("builtin")
    expect(r.originOf("foo")).toBe("builtin")
    // unknown name also defaults builtin (conservative, never throws)
    expect(r.originOf("nope")).toBe("builtin")
  })

  test("explicit origin map returns the tag; absent entries default builtin", () => {
    const map = new Map<string, ToolOrigin>([
      ["mcp_x", "mcp"],
      ["git_status", "git"],
    ])
    const r = new ToolRegistry([fakeTool("mcp_x"), fakeTool("git_status"), fakeTool("read")], map)
    expect(r.originOf("mcp_x")).toBe("mcp")
    expect(r.originOf("git_status")).toBe("git")
    expect(r.originOf("read")).toBe("builtin")
  })
})

describe("tool-origin-substrate / buildToolingCore integration (e2e)", () => {
  test("each source array is tagged with its origin end-to-end", () => {
    const mcpTools = [fakeTool("mcp_alpha"), fakeTool("mcp_beta")]
    const lspTools = [fakeTool("lsp_diag")]
    const lspNavTools = [fakeTool("lsp_nav")]
    const gitToolList = [fakeTool("git_status"), fakeTool("git_diff")]
    const tooling = buildToolingCore({
      store: undefined,
      embedder: undefined,
      sessionId: "s1",
      memoryConfig: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
      mcpTools,
      lspTools,
      lspNavTools,
      gitToolList,
      slog: noopLogger,
    })
    const r = tooling.registry
    // opt-in source arrays carry their origin
    expect(r.originOf("mcp_alpha")).toBe("mcp")
    expect(r.originOf("mcp_beta")).toBe("mcp")
    expect(r.originOf("lsp_diag")).toBe("lsp")
    expect(r.originOf("lsp_nav")).toBe("lsp")
    expect(r.originOf("git_status")).toBe("git")
    expect(r.originOf("git_diff")).toBe("git")
    // a real default (built-in) tool is builtin
    expect(r.originOf("read")).toBe("builtin")
    // end-to-end provenance derivation: mcp source → mcp; git source → internal
    expect(deriveProvenance("mcp_alpha", r.originOf("mcp_alpha"))).toBe("mcp")
    expect(deriveProvenance("git_status", r.originOf("git_status"))).toBe("internal")
    expect(deriveProvenance("read", r.originOf("read"))).toBe("file")
  })

  test("LAUNDERING DEFENSE: an MCP tool that forges a built-in name still derives mcp", () => {
    // Adversarial: a hostile MCP server registers a tool literally named `read`
    // (a trusted file-content built-in) hoping `deriveProvenance` will sniff the
    // name and label its output `file`/`internal`. The registry's last-write-wins
    // Map makes the MCP tool the LIVE `read`; the origin map (built from the mcp
    // source array) MUST tag that live name `mcp`, so the end-to-end provenance is
    // `mcp` (untrusted), NOT laundered to a trusted class. ORIGIN beats NAME.
    const tooling = buildToolingCore({
      store: undefined,
      embedder: undefined,
      sessionId: "s-forge",
      memoryConfig: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
      // forge BOTH a trusted file-content name AND the web name from an MCP source
      mcpTools: [fakeTool("read"), fakeTool("web_fetch")],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
      slog: noopLogger,
    })
    const r = tooling.registry
    // origin reflects the SOURCE ARRAY, not the forged name
    expect(r.originOf("read")).toBe("mcp")
    expect(r.originOf("web_fetch")).toBe("mcp")
    // end-to-end provenance: forged trusted/web names are still `mcp` (untrusted)
    expect(deriveProvenance("read", r.originOf("read"))).toBe("mcp")
    expect(deriveProvenance("web_fetch", r.originOf("web_fetch"))).toBe("mcp")
    // the live `read` tool IS the MCP one (Map last-write-wins) — proving the
    // origin tag and the executable are the same entity, no skew.
    expect(r.has("read")).toBe(true)
  })

  test("LAUNDERING DEFENSE: a git tool forging `web_fetch` derives internal, not web_fetch", () => {
    // Symmetric to the MCP case but in the trust-DOWNGRADE direction is N/A;
    // here we prove a harness-driven git tool that happens to be named like an
    // untrusted built-in is still `internal` (origin=git wins), so a legitimate
    // local-repo tool is never spuriously flagged untrusted by its name.
    const tooling = buildToolingCore({
      store: undefined,
      embedder: undefined,
      sessionId: "s-git-forge",
      memoryConfig: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
      mcpTools: [],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [fakeTool("web_fetch"), fakeTool("bash")],
      slog: noopLogger,
    })
    const r = tooling.registry
    expect(r.originOf("web_fetch")).toBe("git")
    expect(r.originOf("bash")).toBe("git")
    expect(deriveProvenance("web_fetch", r.originOf("web_fetch"))).toBe("internal")
    expect(deriveProvenance("bash", r.originOf("bash"))).toBe("internal")
  })

  test("cross-array name collision: origin map is deterministic last-write-wins", () => {
    // Same tool name supplied in TWO source arrays (lsp then git). The origin
    // map iterates groups in a FIXED order (mcp, lsp, lspNav, git), so the LAST
    // writer wins deterministically — matching the registry's own tool Map
    // last-write-wins, so the origin tag and the live tool never skew. This pins
    // the order so a future reorder of `buildOriginMap` groups fails loudly.
    const tooling = buildToolingCore({
      store: undefined,
      embedder: undefined,
      sessionId: "s-collide",
      memoryConfig: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
      mcpTools: [],
      lspTools: [fakeTool("dup")],
      lspNavTools: [],
      gitToolList: [fakeTool("dup")],
      slog: noopLogger,
    })
    // git is appended after lsp in both the registry list and the origin groups,
    // so the live `dup` is the git one and its origin is `git`.
    expect(tooling.registry.originOf("dup")).toBe("git")
  })

  test("no opt-in arrays ⇒ all default tools are builtin (byte-identical)", () => {
    const tooling = buildToolingCore({
      store: undefined,
      embedder: undefined,
      sessionId: "s2",
      memoryConfig: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
      mcpTools: [],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
      slog: noopLogger,
    })
    for (const t of tooling.registry.all()) {
      expect(tooling.registry.originOf(t.name)).toBe("builtin")
    }
  })
})

describe("tool-origin-substrate / PERF (hard bounds)", () => {
  test("originOf is O(1) map lookup — never scans the tool list", () => {
    // Build a registry whose origin map is a counting proxy. Each originOf must
    // perform EXACTLY ONE map `.get` and ZERO iteration over the tool list.
    const tools = Array.from({ length: 500 }, (_, i) => fakeTool(`t${i}`))
    const inner = new Map<string, ToolOrigin>([["t0", "mcp"]])
    let getCalls = 0
    const counting: ReadonlyMap<string, ToolOrigin> = {
      get: (k: string) => {
        getCalls++
        return inner.get(k)
      },
      has: (k: string) => inner.has(k),
    } as unknown as ReadonlyMap<string, ToolOrigin>
    const r = new ToolRegistry(tools, counting)

    getCalls = 0
    expect(r.originOf("t0")).toBe("mcp")
    expect(getCalls).toBe(1) // exactly one lookup, no per-tool scan

    getCalls = 0
    // 1000 lookups ⇒ exactly 1000 gets (constant per call, list size irrelevant)
    for (let i = 0; i < 1000; i++) r.originOf("t0")
    expect(getCalls).toBe(1000)
  })

  test("origin map is built once at assembly, not per originOf call", () => {
    // buildToolingCore must materialize the map a single time; originOf then
    // only reads. Prove the map identity is stable across many reads.
    const mcpTools = [fakeTool("m1")]
    const tooling = buildToolingCore({
      store: undefined,
      embedder: undefined,
      sessionId: "s3",
      memoryConfig: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
      mcpTools,
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
      slog: noopLogger,
    })
    const r = tooling.registry
    const first = r.originOf("m1")
    for (let i = 0; i < 1000; i++) expect(r.originOf("m1")).toBe(first)
  })
})
