/**
 * ADR-0422 follow-up — production `@symbol` deps builder END-TO-END hellgate.
 *
 * Proves `@Symbol` ACTUALLY resolves in production wiring (no longer the
 * always-`null` deliberate hold). Two strategy paths are exercised:
 *
 *   A. LSP path — REAL deterministic anchor synthesis over a REAL temp
 *      workspace (.ts / .py files), FAKE LspNavProvider injected (no language
 *      server is installed in CI). Proves anchors→union→workspaceSymbol→hit.
 *   B. semantic path — REAL `@/runner` in-memory semantic backend, upserted
 *      with a real chunk, hashEmbed embedder. Proves `@FooBar`→embed→query→hit.
 *   C. auto fallback — fake LSP MISS ⇒ the semantic hit is used.
 *   D. byte-identical — `QUANTA_MENTION_SYMBOL=off` ⇒ no deps at all.
 *   E. no-throw — a throwing anchor lister / index ⇒ null, turn survives.
 *   F. production proof — the deps feed `buildDefaultMentionResolver` and a
 *      `@Symbol` mention injects a fragment (the real end-to-end loop seam).
 *
 * The whole point: with this wire, production `@Symbol` is NOT unconditionally
 * null — given an anchor (synthesized) OR an index entry it returns a hit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildInjectionFragments,
  createSemanticSymbolLookup,
  parseMentions,
  type SymbolLookupSemanticPort,
} from "@/agent/mention-injection"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"
import { buildSemanticBackend, selectIndexEmbedder } from "@/runner/assemble/search-index-backend"
import type { LspNavProvider, LspNavSession, NavSymbolInfo } from "@/tool"
import { buildMentionSymbolDeps } from "../mention-symbol-deps"

const SYMBOL = "QUANTA_MENTION_SYMBOL"
const SKILL = "QUANTA_MENTION_SKILL"
const FILE = "QUANTA_MENTION_FILE"

/** A fake LspNavProvider that opens a session for ANY file and returns a fixed
 *  workspaceSymbol payload. Records which anchor files it was asked to open. */
const fakeLspProvider = (
  payload: (query: string) => NavSymbolInfo[] | null,
): { provider: LspNavProvider; opened: () => string[] } => {
  const opened: string[] = []
  const notImpl = async (): Promise<never> => {
    throw new Error("not used")
  }
  const session: LspNavSession = {
    definition: notImpl,
    references: notImpl,
    hover: notImpl,
    typeDefinition: notImpl,
    implementation: notImpl,
    documentSymbol: notImpl,
    workspaceSymbol: async (q) => payload(q),
    prepareRename: notImpl,
    stop: async () => undefined,
  }
  return {
    opened: () => opened,
    provider: {
      unavailableReason: () => "n/a",
      open: async (file) => {
        opened.push(file)
        return session
      },
    },
  }
}

const sym = (name: string, line0: number, uri: string): NavSymbolInfo => ({
  name,
  kind: "function",
  range: { start: { line: line0, character: 0 }, end: { line: line0, character: 1 } },
  selectionRange: { start: { line: line0, character: 0 }, end: { line: line0, character: 1 } },
  uri,
})

/** Build a REAL in-memory semantic lookup, upserted with one chunk. */
const realSemanticLookup = async (chunk: {
  path: string
  text: string
  startLine: number
}): Promise<SymbolLookupSemanticPort> => {
  const env = {} as NodeJS.ProcessEnv // no provider ⇒ hashEmbed (deterministic)
  const embed = selectIndexEmbedder(env)
  const backend = buildSemanticBackend(env, embed)
  await backend.upsert.upsert({
    path: chunk.path,
    text: chunk.text,
    startLine: chunk.startLine,
    endLine: chunk.startLine + 1,
  })
  return createSemanticSymbolLookup({ index: backend.port, embed })
}

describe("buildMentionSymbolDeps — ADR-0422 follow-up production hellgate", () => {
  let dir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mention-symdeps-"))
    for (const k of [SYMBOL, SKILL, FILE]) saved[k] = process.env[k]
    delete process.env[SYMBOL]
    delete process.env[SKILL]
    delete process.env[FILE]
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of [SYMBOL, SKILL, FILE]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  // -------- A. LSP path over a REAL workspace + FAKE provider ----------
  test("A1 — real .ts anchor synthesized ⇒ fake LSP probed at THAT anchor ⇒ hit", async () => {
    writeFileSync(join(dir, "main.ts"), "export function Foo() {}", "utf8")
    const lsp = fakeLspProvider(() => [sym("Foo", 0, "main.ts")])
    const deps = buildMentionSymbolDeps(dir, process.env, { lspProvider: lsp.provider })
    const hits = await deps.lsp?.findSymbol("Foo")
    expect(hits?.length).toBe(1)
    expect(hits?.[0]?.path).toBe("main.ts")
    // The fake server was opened against the SYNTHESIZED anchor (main.ts).
    expect(lsp.opened()).toContain(join(dir, "main.ts"))
  })

  test("A2 — multi-language workspace ⇒ BOTH anchors probed (union)", async () => {
    writeFileSync(join(dir, "a.ts"), "export const A = 1", "utf8")
    writeFileSync(join(dir, "b.py"), "B = 1", "utf8")
    const lsp = fakeLspProvider((q) => [sym(q, 0, "hit")])
    const deps = buildMentionSymbolDeps(dir, process.env, { lspProvider: lsp.provider })
    await deps.lsp?.findSymbol("Whatever")
    const opened = lsp.opened()
    expect(opened.some((p) => p.endsWith(".ts"))).toBe(true)
    expect(opened.some((p) => p.endsWith(".py"))).toBe(true)
  })

  test("A3 — NO supported source file ⇒ LSP port answers null (anchor disabled)", async () => {
    writeFileSync(join(dir, "README.md"), "# docs", "utf8")
    const lsp = fakeLspProvider(() => [sym("Foo", 0, "x")])
    const deps = buildMentionSymbolDeps(dir, process.env, { lspProvider: lsp.provider })
    expect(await deps.lsp?.findSymbol("Foo")).toBeNull()
    expect(lsp.opened()).toEqual([]) // never opened — no anchor synthesized
  })

  // -------- B. REAL semantic backend ----------------------------------
  test("B1 — real in-memory index hit ⇒ @symbol resolves via semantic", async () => {
    const semanticLookup = await realSemanticLookup({
      path: "src/foo.ts",
      text: "class FooBar { run() {} }",
      startLine: 12,
    })
    const deps = buildMentionSymbolDeps(dir, process.env, { semanticLookup })
    const hits = await deps.semantic?.findSymbol("FooBar")
    expect(hits?.length).toBeGreaterThan(0)
    expect(hits?.[0]?.path).toBe("src/foo.ts")
    expect(hits?.[0]?.line).toBe(12)
  })

  test("B2 — empty real index ⇒ semantic answers null (graceful)", async () => {
    const env = {} as NodeJS.ProcessEnv
    const embed = selectIndexEmbedder(env)
    const backend = buildSemanticBackend(env, embed)
    const semanticLookup = createSemanticSymbolLookup({ index: backend.port, embed })
    const deps = buildMentionSymbolDeps(dir, process.env, { semanticLookup })
    expect(await deps.semantic?.findSymbol("Nothing")).toBeNull()
  })

  // -------- C. auto fallback (LSP miss ⇒ semantic hit) ----------------
  test("C1 — fake LSP miss + real semantic hit ⇒ resolver uses semantic (auto)", async () => {
    writeFileSync(join(dir, "main.ts"), "x", "utf8")
    const lsp = fakeLspProvider(() => []) // LSP always misses
    const semanticLookup = await realSemanticLookup({
      path: "src/bar.ts",
      text: "function MyHelper() {}",
      startLine: 4,
    })
    const deps = buildMentionSymbolDeps(dir, process.env, {
      lspProvider: lsp.provider,
      semanticLookup,
    })
    const resolver = buildDefaultMentionResolver({ cwd: dir, env: process.env, ...deps })
    const frags = await buildInjectionFragments(parseMentions("look at @MyHelper"), resolver)
    expect(frags.length).toBe(1)
    expect(JSON.stringify(frags)).toContain("src/bar.ts")
  })

  // -------- D. byte-identical OFF -------------------------------------
  test("D1 — QUANTA_MENTION_SYMBOL=off ⇒ NO deps built (both absent)", () => {
    process.env[SYMBOL] = "off"
    const deps = buildMentionSymbolDeps(dir, process.env, {
      lspProvider: fakeLspProvider(() => [sym("X", 0, "x")]).provider,
    })
    expect(deps.lsp).toBeUndefined()
    expect(deps.semantic).toBeUndefined()
  })

  test("D2 — OFF ⇒ resolver omits @symbol ⇒ a @Symbol mention injects nothing", async () => {
    process.env[SYMBOL] = "off"
    const deps = buildMentionSymbolDeps(dir, process.env)
    const resolver = buildDefaultMentionResolver({ cwd: dir, env: process.env, ...deps })
    const frags = await buildInjectionFragments(parseMentions("see @SomeSymbol"), resolver)
    expect(frags).toEqual([])
  })

  // -------- E. NO-THROW -----------------------------------------------
  test("E1 — anchor lister throws ⇒ LSP port null (NO-THROW, turn survives)", async () => {
    const deps = buildMentionSymbolDeps(dir, process.env, {
      lister: { readDir: async () => Promise.reject(new Error("boom")) },
    })
    // root readDir rejects ⇒ no anchors ⇒ null (synthesizer swallows it).
    expect(await deps.lsp?.findSymbol("X")).toBeNull()
  })

  test("E2 — semantic lookup throws on query ⇒ null (NO-THROW)", async () => {
    const throwing: SymbolLookupSemanticPort = {
      findSymbol: async () => Promise.reject(new Error("index down")),
    }
    const deps = buildMentionSymbolDeps(dir, process.env, { semanticLookup: throwing })
    expect(await deps.semantic?.findSymbol("X")).toBeNull()
  })

  // -------- F. production end-to-end proof -----------------------------
  test("F1 — full production wire: @Symbol injects a fragment (NOT null)", async () => {
    writeFileSync(join(dir, "app.ts"), "export class Widget {}", "utf8")
    const lsp = fakeLspProvider((q) => [sym(q, 6, "app.ts")])
    const deps = buildMentionSymbolDeps(dir, process.env, { lspProvider: lsp.provider })
    const resolver = buildDefaultMentionResolver({ cwd: dir, env: process.env, ...deps })
    const frags = await buildInjectionFragments(parseMentions("inspect @Widget"), resolver)
    expect(frags.length).toBe(1)
    expect(JSON.stringify(frags)).toContain("app.ts")
  })
})
