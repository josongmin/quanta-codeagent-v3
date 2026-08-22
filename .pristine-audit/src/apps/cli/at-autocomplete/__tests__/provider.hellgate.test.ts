/**
 * RFC-12 / ADR-0439 — `@`-autocomplete provider + ranking + state-machine
 * hellgate. Covers §7 cases 13-15 (provider unit) PLUS the pure ranking +
 * state-machine primitives the keypress integration relies on.
 *
 *   A. fuzzy 2-tier ranking (prefix > substring, stable)   (5)
 *   B. file enumerate (cap + jail + symlink-escape)         (5)
 *   C. symbol enumerate (graceful + projection)             (4)
 *   D. composite kind inference + skill/plugin/app list     (6)
 *   E. state-machine primitives (boundary/char/bs/accept)   (8)
 *
 * Real fs is used ONLY for the file-lister cases (tmpdir fixture); no TTY,
 * no LSP server (a fake `SymbolLookupLspPort` drives the symbol path).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMentions, type SymbolHit, type SymbolLookupLspPort } from "@/agent/mention-injection"
import { matchTier, rankByTier } from "../fuzzy"
import { createCompositeAtProvider } from "../provider"
import { createRecursiveFileLister } from "../recursive-file-list"
import {
  type AtState,
  acceptSelected,
  atQuery,
  classifyBackspace,
  classifyChar,
  createAtState,
  isAtTriggerBoundaryOk,
  selectNext,
  selectPrev,
} from "../state-machine"
import { createSymbolLister } from "../symbol-list"

// ── A. fuzzy ranking ───────────────────────────────────────────────────

describe("rankByTier — deterministic 2-tier (§4.5)", () => {
  test("A1 — prefix matches sort before substring matches", () => {
    const out = rankByTier(["xutil", "util", "futil", "util-log"], "util")
    // prefix (util, util-log) tier 0 in input order; substring (xutil, futil) tier 1.
    expect(out.map((r) => r.value)).toEqual(["util", "util-log", "xutil", "futil"])
  })

  test("A2 — case-insensitive tiers: exact<prefix<substring", () => {
    expect(matchTier("UTIL", "util")).toBe(0) // exact (case-insensitive)
    expect(matchTier("UtilLog", "util")).toBe(1) // prefix
    expect(matchTier("xUtilLog", "util")).toBe(2) // substring
    expect(matchTier("nope", "util")).toBe(-1)
  })

  test("A2b — exact floats above prefix floats above substring", () => {
    // query exactly equals "util": exact wins, then prefix, then substring —
    // regardless of input order (exact `util` is LAST in input here).
    const out = rankByTier(["util-helper", "xutil", "util"], "util")
    expect(out.map((r) => r.value)).toEqual(["util", "util-helper", "xutil"])
  })

  test("A3 — empty query keeps every value in input order (tier 0)", () => {
    const out = rankByTier(["b", "a", "c"], "")
    expect(out.map((r) => r.value)).toEqual(["b", "a", "c"])
    expect(out.every((r) => r.tier === 0)).toBe(true)
  })

  test("A4 — no-match filtered out", () => {
    expect(rankByTier(["alpha", "beta"], "zzz")).toEqual([])
  })

  test("A5 — stable on equal tier (original index breaks ties)", () => {
    const out = rankByTier(["aX", "aY", "aZ"], "a")
    expect(out.map((r) => r.index)).toEqual([0, 1, 2])
  })
})

// ── B. file enumerate ──────────────────────────────────────────────────

describe("createRecursiveFileLister — recursive walk + cap + jail (§7-13)", () => {
  let root: string
  let outside: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "at-file-"))
    outside = mkdtempSync(join(tmpdir(), "at-out-"))
    mkdirSync(join(root, "src"))
    mkdirSync(join(root, "src", "apps"))
    mkdirSync(join(root, "src", "apps", "bench"))
    mkdirSync(join(root, "node_modules"))
    mkdirSync(join(root, "node_modules", "dep"))
    writeFileSync(join(root, "src", "util.ts"), "x")
    writeFileSync(join(root, "src", "utils-log.ts"), "x")
    writeFileSync(join(root, "src", "other.ts"), "x")
    // a DEEP file — the headline regression: a bare basename must reach it.
    writeFileSync(join(root, "src", "apps", "bench", "driver.ts"), "x")
    writeFileSync(join(root, "README.md"), "x")
    writeFileSync(join(root, ".gitignore"), "ignored-dir/\n")
    mkdirSync(join(root, "ignored-dir"))
    writeFileSync(join(root, "ignored-dir", "junk.ts"), "x")
    writeFileSync(join(root, "node_modules", "dep", "index.ts"), "x")
    writeFileSync(join(outside, "secret.txt"), "x")
    // symlink inside root pointing OUT of root
    try {
      symlinkSync(outside, join(root, "escape"))
    } catch {
      /* symlink may be unsupported in some CI sandboxes; the escape test
         tolerates absence below. */
    }
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  // `forceWalk()` pins the JS-walk fallback (rg source returns null) so the
  // jail / prune teeth are exercised deterministically regardless of whether
  // `rg` is on PATH. It is a FACTORY (not a const) because `root` is only
  // assigned in `beforeAll` — capturing it at describe-eval time would pin
  // `undefined`.
  const forceWalk = () => ({ fileRoot: root, fileSource: async () => null }) as const

  test("B1 — a bare basename query reaches a DEEP file (the regression fix)", async () => {
    // default source (real `rg --files`, or the walk if rg is absent)
    const list = createRecursiveFileLister({ fileRoot: root })
    const out = await list("driver")
    expect(out.map((c) => c.label)).toContain("src/apps/bench/driver.ts")
  })

  test("B1b — a slash query matches the full relative path", async () => {
    const list = createRecursiveFileLister(forceWalk())
    const out = await list("src/util")
    const labels = out.map((c) => c.label)
    expect(labels).toContain("src/util.ts")
    expect(labels).toContain("src/utils-log.ts")
    expect(labels).not.toContain("src/other.ts")
  })

  test("B2 — every candidate carries an `@`-prefixed insertText + file kind", async () => {
    const list = createRecursiveFileLister(forceWalk())
    const out = await list("util")
    expect(out.length).toBeGreaterThan(0)
    for (const c of out) {
      expect(c.kind).toBe("file")
      expect(c.insertText.startsWith("@")).toBe(true)
    }
  })

  test("B3 — maxResults cap is honoured", async () => {
    const list = createRecursiveFileLister({ ...forceWalk(), maxResults: 1 })
    const out = await list("ts")
    expect(out.length).toBeLessThanOrEqual(1)
  })

  test("B4 — absolute query never escapes the jail", async () => {
    const list = createRecursiveFileLister(forceWalk())
    expect(await list(`${outside}/secret`)).toEqual([])
  })

  test("B5 — a symlink dir escaping root is never indexed (walk path)", async () => {
    const list = createRecursiveFileLister(forceWalk())
    // the outside file must NEVER surface, under any query shape
    const out = await list("secret")
    expect(out.every((c) => !c.label.includes("secret"))).toBe(true)
  })

  test("B6 — node_modules + .gitignore'd dirs are pruned (walk path)", async () => {
    const list = createRecursiveFileLister(forceWalk())
    expect(await list("junk")).toEqual([]) // ignored-dir/junk.ts never indexed
    const dep = await list("index")
    expect(dep.map((c) => c.label)).not.toContain("node_modules/dep/index.ts")
  })

  test("B7 — rg source result is expanded with ancestor DIR candidates", async () => {
    // Inject a deterministic rg-style file list (no subprocess) and assert
    // both files AND their derived directories surface.
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => ["src/apps/bench/driver.ts", "README.md"],
    })
    const dirs = await list("apps")
    expect(dirs.find((c) => c.label === "src/apps/" && c.detail === "dir")).toBeDefined()
    const file = await list("driver")
    expect(
      file.find((c) => c.label === "src/apps/bench/driver.ts" && c.detail === "file"),
    ).toBeDefined()
  })

  test("B8 — rg source that yields nothing ⇒ empty, not a crash", async () => {
    const list = createRecursiveFileLister({ fileRoot: root, fileSource: async () => [] })
    expect(await list("anything")).toEqual([])
  })

  test("B9 — source enumerated ONCE, then cached (no per-keystroke rebuild)", async () => {
    let calls = 0
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        calls += 1
        return ["src/util.ts", "src/driver.ts"]
      },
    })
    await list("u")
    await list("dr")
    await list("")
    expect(calls).toBe(1) // built once, filtered in-memory thereafter
  })

  test("B10 — concurrent first-calls share ONE build", async () => {
    let calls = 0
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => {
        calls += 1
        return ["a.ts"]
      },
    })
    await Promise.all([list("a"), list("a"), list("a")])
    expect(calls).toBe(1)
  })

  test("B11 — JAIL on a malicious source: absolute / `..`-escaping paths dropped", async () => {
    const list = createRecursiveFileLister({
      fileRoot: root,
      fileSource: async () => ["../escape.txt", "/etc/passwd", "a/../../b.txt", "src/ok.ts"],
    })
    expect((await list("escape")).map((c) => c.label)).toEqual([])
    expect((await list("passwd")).map((c) => c.label)).toEqual([])
    expect((await list("b.txt")).map((c) => c.label)).toEqual([])
    // the one legitimate in-root path survives — proves the filter isn't
    // just returning [] for everything (paired control).
    expect((await list("ok")).map((c) => c.label)).toContain("src/ok.ts")
  })

  test("B12 — maxFiles caps the INDEX, dropping the deepest entries", async () => {
    const list = createRecursiveFileLister({
      fileRoot: root,
      maxFiles: 2,
      fileSource: async () => ["a.ts", "d1/b.ts", "d1/d2/deepfile.ts"],
    })
    // shallow-first: a.ts + dir d1 fill the 2-slot index; the deep file is cut.
    expect(await list("deepfile")).toEqual([])
    expect((await list("a")).map((c) => c.label)).toContain("a.ts")
  })

  test("B13 — rg exit code is irrelevant when stdout has files (real rg)", async () => {
    // Drives the REAL `ripgrepFileSource` against the workspace root; if rg is
    // absent it degrades to the walk — either way the deep file must surface.
    // (Regression guard for: discarding valid stdout on a non-zero exit.)
    const list = createRecursiveFileLister({ fileRoot: root })
    expect((await list("driver")).map((c) => c.label)).toContain("src/apps/bench/driver.ts")
  })
})

// ── C. symbol enumerate ────────────────────────────────────────────────

describe("createSymbolLister — graceful + projection (§7-14)", () => {
  test("C1 — absent port ⇒ []", async () => {
    const list = createSymbolLister({})
    expect(await list("Foo")).toEqual([])
  })

  test("C2 — empty query ⇒ [] (no useless workspaceSymbol probe)", async () => {
    const port: SymbolLookupLspPort = { findSymbol: async () => [{ path: "a.ts", line: 1 }] }
    const list = createSymbolLister({ symbolLookup: port })
    expect(await list("")).toEqual([])
  })

  test("C3 — null payload ⇒ [] (graceful, like no-anchor LSP)", async () => {
    const port: SymbolLookupLspPort = { findSymbol: async () => null }
    const list = createSymbolLister({ symbolLookup: port })
    expect(await list("Foo")).toEqual([])
  })

  test("C4 — hit projected to @symbol candidate with path:line detail", async () => {
    const hits: SymbolHit[] = [{ path: "src/codec.ts", line: 91, snippet: "class Utf8Decoder" }]
    const port: SymbolLookupLspPort = { findSymbol: async () => hits }
    const list = createSymbolLister({ symbolLookup: port })
    const out = await list("Utf")
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("symbol")
    expect(out[0]?.insertText).toBe("@Utf8Decoder")
    expect(out[0]?.detail).toBe("src/codec.ts:91")
  })
})

// ── D. composite kind inference ────────────────────────────────────────

describe("createCompositeAtProvider — kind inference + lists (§7-15)", () => {
  const root = mkdtempSync(join(tmpdir(), "at-comp-"))
  beforeAll(() => {
    writeFileSync(join(root, "alpha.ts"), "x")
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("D1 — slash query routes to file lister", async () => {
    const p = createCompositeAtProvider({ fileRoot: root })
    const out = await p.list("alph")
    // lowercase no-slash query still probes files (covers @foo.ts)
    expect(out.some((c) => c.kind === "file")).toBe(true)
  })

  test("D2 — uppercase query routes to symbol lister", async () => {
    const port: SymbolLookupLspPort = {
      findSymbol: async () => [{ path: "x.ts", line: 2, snippet: "class FooBar" }],
    }
    const p = createCompositeAtProvider({ fileRoot: root, symbolLookup: port })
    const out = await p.list("Foo")
    expect(out.every((c) => c.kind === "symbol")).toBe(true)
    expect(out[0]?.insertText).toBe("@FooBar")
  })

  test("D3 — skill list callback surfaces @kebab candidates", async () => {
    const p = createCompositeAtProvider({
      fileRoot: root,
      listSkills: () => [{ name: "code-review", description: "Review the diff\nmore" }],
    })
    const out = await p.list("code")
    const skill = out.find((c) => c.kind === "skill")
    expect(skill?.insertText).toBe("@code-review")
    expect(skill?.detail).toBe("Review the diff")
  })

  test("D4 — plugin list callback surfaces plugin:// candidates", async () => {
    const p = createCompositeAtProvider({
      fileRoot: root,
      listPlugins: () => [{ name: "github", description: "GH" }],
    })
    const out = await p.list("git")
    expect(out.find((c) => c.kind === "plugin")?.insertText).toBe("plugin://github")
  })

  test("D5 — app list callback surfaces @@app candidates", async () => {
    const p = createCompositeAtProvider({
      fileRoot: root,
      listApps: () => [{ name: "slack", description: "Slack" }],
    })
    const out = await p.list("sla")
    expect(out.find((c) => c.kind === "app")?.insertText).toBe("@@slack")
  })

  test("D6 — absent skill/plugin/app callbacks ⇒ those kinds contribute 0", async () => {
    const p = createCompositeAtProvider({ fileRoot: root })
    const out = await p.list("zzz-no-such")
    expect(
      out.filter((c) => c.kind === "skill" || c.kind === "plugin" || c.kind === "app"),
    ).toEqual([])
  })

  test("D7 — a throwing sub-lister degrades to [] (NO-THROW)", async () => {
    const port: SymbolLookupLspPort = {
      findSymbol: async () => {
        throw new Error("boom")
      },
    }
    const p = createCompositeAtProvider({ fileRoot: root, symbolLookup: port })
    expect(await p.list("Foo")).toEqual([])
  })

  test("D8 — a SYNCHRONOUSLY-throwing kebab lister must NOT wipe file candidates", async () => {
    // Regression for the Promise.all bug: `deps.listSkills()` runs synchronously
    // inside the array literal, so an unguarded throw there rejected the whole
    // batch and dropped the (safe) file candidates too. Each kebab lister is now
    // wrapped in `safe`, so the skill failure stays isolated and `alpha.ts`
    // (matched by the lowercase file probe) still surfaces.
    const p = createCompositeAtProvider({
      fileRoot: root,
      listSkills: () => {
        throw new Error("boom-sync")
      },
    })
    const out = await p.list("alph")
    expect(out.some((c) => c.kind === "file")).toBe(true) // files survived
    expect(out.some((c) => c.kind === "skill")).toBe(false) // skill failure isolated
  })

  test("D9 — files are NOT starved by many matching kebab candidates", async () => {
    // 10 skills match "alp"; the prior files-LAST order put the file at index
    // 10 — past the 8-row visible window ⇒ invisible. Files-first puts it at
    // the very front.
    const p = createCompositeAtProvider({
      fileRoot: root, // has alpha.ts
      listSkills: () =>
        Array.from({ length: 10 }, (_, i) => ({ name: `alp-${i}`, description: "x" })),
    })
    const out = await p.list("alp")
    expect(out[0]?.kind).toBe("file")
    expect(out[0]?.label).toBe("alpha.ts")
  })

  test("D10 — uppercase-leading real file (e.g. @README) still resolves", async () => {
    const up = mkdtempSync(join(tmpdir(), "at-upper-"))
    writeFileSync(join(up, "README.md"), "x")
    try {
      // No symbolLookup ⇒ symbol kind empty; the file probe must still run for
      // an uppercase query (regression: uppercase was symbol-only).
      const p = createCompositeAtProvider({ fileRoot: up })
      const out = await p.list("README")
      expect(out.find((c) => c.kind === "file")?.label).toBe("README.md")
    } finally {
      rmSync(up, { recursive: true, force: true })
    }
  })

  // ── RFC-12-2: mcp / subagent / thread listers ────────────────────────
  test("D11 — listMcpServers surfaces @mcp:<name> candidates", async () => {
    const p = createCompositeAtProvider({
      fileRoot: root,
      listMcpServers: () => [{ name: "github", description: "GitHub MCP\nmore" }],
    })
    const c = (await p.list("git")).find((x) => x.kind === "mcp")
    expect(c?.insertText).toBe("@mcp:github")
    expect(c?.label).toBe("github")
    expect(c?.detail).toBe("GitHub MCP")
  })

  test("D12 — listSubagents surfaces @subagent:<name> candidates", async () => {
    const p = createCompositeAtProvider({
      fileRoot: root,
      listSubagents: () => [{ name: "explorer", description: "Read-only explorer" }],
    })
    const c = (await p.list("expl")).find((x) => x.kind === "subagent")
    expect(c?.insertText).toBe("@subagent:explorer")
  })

  test("D13 — listThreads inserts the opaque id but LABELS the human title", async () => {
    const p = createCompositeAtProvider({
      fileRoot: root,
      // name = title (searchable/displayed), insertName = id (resolver payload).
      listThreads: () => [{ name: "fix the parser", description: "/repo", insertName: "abc-1" }],
    })
    const c = (await p.list("fix")).find((x) => x.kind === "thread")
    expect(c?.label).toBe("fix the parser")
    expect(c?.insertText).toBe("@thread:abc-1")
  })

  test("D14 — RED-ON-INJECTION: drop a lister ⇒ ONLY its kind vanishes", async () => {
    // subagent + thread present, mcp ABSENT ⇒ no mcp rows, others survive.
    const p = createCompositeAtProvider({
      fileRoot: root,
      listSubagents: () => [{ name: "xray", description: "x" }],
      listThreads: () => [{ name: "xylo", description: "y", insertName: "id-x" }],
    })
    const out = await p.list("x")
    expect(out.some((c) => c.kind === "mcp")).toBe(false) // dropped lister ⇒ kind gone
    expect(out.some((c) => c.kind === "subagent")).toBe(true) // paired control
    expect(out.some((c) => c.kind === "thread")).toBe(true)
  })

  test("D15 — absent RFC-12-2 listers ⇒ those kinds contribute 0 (byte-identical)", async () => {
    const p = createCompositeAtProvider({ fileRoot: root })
    const out = await p.list("zzz-no-such")
    expect(
      out.filter((c) => c.kind === "mcp" || c.kind === "subagent" || c.kind === "thread"),
    ).toEqual([])
  })

  test("D16 — a throwing RFC-12-2 lister degrades to [] and does NOT wipe others", async () => {
    const p = createCompositeAtProvider({
      fileRoot: root,
      listMcpServers: () => {
        throw new Error("boom-sync")
      },
      listSubagents: () => [{ name: "alp-agent", description: "z" }],
    })
    const out = await p.list("alp")
    expect(out.some((c) => c.kind === "mcp")).toBe(false) // isolated failure
    expect(out.some((c) => c.kind === "subagent")).toBe(true) // survived
    expect(out.some((c) => c.kind === "file")).toBe(true) // files survived too
  })

  test("D17 — ROUND-TRIP: each RFC-12-2 candidate's insertText re-parses to its kind+target", async () => {
    // The full accept→submit loop (RFC §4.6): what the dropdown splices into the
    // buffer MUST re-classify under `parseMentions` to the SAME kind+target the
    // `@thread:`/`@mcp:`/`@subagent:` resolver then looks up — otherwise the
    // surfaced candidate is dead on accept. `thread` is the sharp case: the
    // inserted payload is the opaque id (`insertName`), NOT the human label.
    const p = createCompositeAtProvider({
      fileRoot: root,
      listMcpServers: () => [{ name: "github", description: "x" }],
      listSubagents: () => [{ name: "explorer", description: "x" }],
      listThreads: () => [{ name: "prior title", description: "x", insertName: "9f8e-1" }],
    })
    for (const [q, kind, target] of [
      ["git", "mcp", "github"],
      ["expl", "subagent", "explorer"],
      ["prior", "thread", "9f8e-1"],
    ] as const) {
      const c = (await p.list(q)).find((x) => x.kind === kind)
      expect(c).toBeDefined()
      const parsed = parseMentions(`please ${c?.insertText} now`)
      expect(parsed[0]).toMatchObject({ kind, target })
    }
  })
})

// ── E. state-machine primitives ────────────────────────────────────────

describe("state-machine — pure keypress decisions (§4.3)", () => {
  test("E0 — selection navigates the FULL list, past the 8-row window", () => {
    // The dropdown now passes the TOTAL count (not min(len,8)) so candidates
    // beyond the visible window are reachable via ↓/↑ (regression: nav wrapped
    // at 8, stranding entries 9+).
    const st: AtState = { ...createAtState(), active: true, selectedIdx: 7 }
    expect(selectNext(st, 12)).toBe(8) // advances past the old cap
    expect(selectPrev({ ...st, selectedIdx: 0 }, 12)).toBe(11) // wraps to true last
    expect(selectNext({ ...st, selectedIdx: 11 }, 12)).toBe(0) // wraps around end
  })

  test("E1 — left-boundary: @ at start / after space triggers; after word does not", () => {
    expect(isAtTriggerBoundaryOk("", 0)).toBe(true)
    expect(isAtTriggerBoundaryOk("hi ", 3)).toBe(true)
    expect(isAtTriggerBoundaryOk("foo", 3)).toBe(false) // foo@ ⇒ no trigger
  })

  test("E2 — classifyChar opens on boundary @ (non-paste)", () => {
    const st = createAtState()
    const r = classifyChar({
      state: st,
      buf: "hi ",
      cursor: 3,
      ch: "@",
      providerPresent: true,
      isPaste: false,
    })
    expect(r).toEqual({ kind: "open", triggerPos: 3 })
  })

  test("E3 — classifyChar does NOT open inside a word", () => {
    const st = createAtState()
    const r = classifyChar({
      state: st,
      buf: "foo",
      cursor: 3,
      ch: "@",
      providerPresent: true,
      isPaste: false,
    })
    expect(r.kind).toBe("ignore")
  })

  test("E4 — paste (@ inside multi-char str) never opens", () => {
    const st = createAtState()
    const r = classifyChar({
      state: st,
      buf: "",
      cursor: 0,
      ch: "foo@bar",
      providerPresent: true,
      isPaste: true,
    })
    expect(r.kind).toBe("ignore")
  })

  test("E5 — provider absent ⇒ always ignore (default-OFF byte-identical)", () => {
    const st = createAtState()
    const r = classifyChar({
      state: st,
      buf: "",
      cursor: 0,
      ch: "@",
      providerPresent: false,
      isPaste: false,
    })
    expect(r.kind).toBe("ignore")
  })

  test("E6 — open dropdown: a mention char re-queries, a space dismisses", () => {
    const st: AtState = { ...createAtState(), active: true, triggerPos: 0 }
    expect(
      classifyChar({
        state: st,
        buf: "@u",
        cursor: 2,
        ch: "t",
        providerPresent: true,
        isPaste: false,
      }).kind,
    ).toBe("requery")
    expect(
      classifyChar({
        state: st,
        buf: "@u",
        cursor: 2,
        ch: " ",
        providerPresent: true,
        isPaste: false,
      }).kind,
    ).toBe("dismiss")
  })

  test("E7 — backspace erasing the @ dismisses; otherwise re-queries", () => {
    const st: AtState = { ...createAtState(), active: true, triggerPos: 2 }
    // cursor at 3 (one char after @) ⇒ delete brings cursor to 2 == triggerPos ⇒ erased @ ⇒ dismiss
    expect(classifyBackspace(st, 3).kind).toBe("dismiss")
    // cursor at 5 ⇒ shrink query ⇒ requery
    expect(classifyBackspace(st, 5).kind).toBe("requery")
  })

  test("E8 — acceptSelected splices insertText over [triggerPos,cursor)", () => {
    const st: AtState = {
      ...createAtState(),
      active: true,
      triggerPos: 3,
      selectedIdx: 0,
      candidates: [{ kind: "file", insertText: "@src/util.ts", label: "src/util.ts" }],
    }
    const edit = acceptSelected(st, "hi @ut", 6)
    expect(edit?.nextBuf).toBe("hi @src/util.ts")
    expect(edit?.nextCursor).toBe(3 + "@src/util.ts".length)
    // atQuery derivation sanity
    expect(atQuery(st, "hi @ut", 6)).toBe("ut")
  })
})
