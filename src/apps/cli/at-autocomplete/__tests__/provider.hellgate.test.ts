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
import type { SymbolHit, SymbolLookupLspPort } from "@/agent/mention-injection"
import { createFileLister } from "../file-list"
import { matchTier, rankByTier } from "../fuzzy"
import { createCompositeAtProvider } from "../provider"
import {
  type AtState,
  acceptSelected,
  atQuery,
  classifyBackspace,
  classifyChar,
  createAtState,
  isAtTriggerBoundaryOk,
} from "../state-machine"
import { createSymbolLister } from "../symbol-list"

// ── A. fuzzy ranking ───────────────────────────────────────────────────

describe("rankByTier — deterministic 2-tier (§4.5)", () => {
  test("A1 — prefix matches sort before substring matches", () => {
    const out = rankByTier(["xutil", "util", "futil", "util-log"], "util")
    // prefix (util, util-log) tier 0 in input order; substring (xutil, futil) tier 1.
    expect(out.map((r) => r.value)).toEqual(["util", "util-log", "xutil", "futil"])
  })

  test("A2 — case-insensitive", () => {
    expect(matchTier("UtilLog", "util")).toBe(0)
    expect(matchTier("xUtilLog", "util")).toBe(1)
    expect(matchTier("nope", "util")).toBe(-1)
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

describe("createFileLister — enumerate cap + jail (§7-13)", () => {
  let root: string
  let outside: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "at-file-"))
    outside = mkdtempSync(join(tmpdir(), "at-out-"))
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "util.ts"), "x")
    writeFileSync(join(root, "src", "utils-log.ts"), "x")
    writeFileSync(join(root, "src", "other.ts"), "x")
    writeFileSync(join(root, "README.md"), "x")
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

  test("B1 — lists files under a sub-dir, filtered by leaf substring", async () => {
    const list = createFileLister({ fileRoot: root })
    const out = await list("src/util")
    const labels = out.map((c) => c.label).sort()
    expect(labels).toContain("src/util.ts")
    expect(labels).toContain("src/utils-log.ts")
    expect(labels).not.toContain("src/other.ts")
  })

  test("B2 — every candidate carries an `@`-prefixed insertText + file kind", async () => {
    const list = createFileLister({ fileRoot: root })
    const out = await list("src/util")
    for (const c of out) {
      expect(c.kind).toBe("file")
      expect(c.insertText.startsWith("@")).toBe(true)
    }
  })

  test("B3 — maxResults cap is honoured", async () => {
    const list = createFileLister({ fileRoot: root, maxResults: 1 })
    const out = await list("src/")
    expect(out.length).toBeLessThanOrEqual(1)
  })

  test("B4 — absolute query never escapes the jail", async () => {
    const list = createFileLister({ fileRoot: root })
    expect(await list(`${outside}/secret`)).toEqual([])
  })

  test("B5 — a symlink dir escaping root is not descended", async () => {
    const list = createFileLister({ fileRoot: root })
    // listing the escape symlink's contents must NOT reveal the outside file
    const out = await list("escape/secret")
    expect(out.map((c) => c.label)).not.toContain("escape/secret.txt")
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
})

// ── E. state-machine primitives ────────────────────────────────────────

describe("state-machine — pure keypress decisions (§4.3)", () => {
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
