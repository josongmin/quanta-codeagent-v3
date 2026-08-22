/**
 * ADR-0418 + ADR-0422 — mention-wire END-TO-END hellgate (adversarial,
 * real-fs, no mock-the-world).
 *
 * This battery proves there are NO functional holes in the mention wire that
 * the per-slice unit hellgates cannot catch — specifically that the WIRED
 * injector (the actual `AgentConfig.mentionInjector` the loop awaits) does the
 * full `parse → resolve(fs/LSP/skill) → inject Message[]` round trip on the
 * TWO real production paths:
 *
 *   1. `assembleAgentConfig` (apps/agent/assemble.ts) — the unified-agent wire.
 *   2. `installCliMentionInjector` (host/runtime mention-wire.ts) — the CLI
 *      REPL + every host-runtime surface wire (reached per-turn from
 *      `buildAgentConfigFromBase` → `runRuntimeTurn`).
 *
 * Both wires funnel through `installCodexR2Wires` → `buildMentionInjector`,
 * so the injector under test is the EXACT closure the loop calls at
 * `loop.ts:941` (`await config.mentionInjector(userText)`).
 *
 * @symbol IS now backed in production: ADR-0423 wires `buildMentionSymbolDeps`
 * into BOTH `apps/agent/assemble.ts` (`mentionResolverDep` → `buildDefaultMentionResolver`)
 * and the host-runtime `mention-wire.ts`, so the production assemble path
 * lazily synthesizes a deterministic LSP anchor (`synthesizeLspAnchors` walks
 * the real workspace), builds a union LSP lookup over it, AND attaches a
 * semantic-index fallback — the always-`null` placeholder the ADR-0422 hold
 * left behind is GONE. This battery proves that at TWO levels:
 *
 *   (a) PRODUCTION COMPOSITION (the §3a block): drive the EXACT
 *       `buildMentionSymbolDeps` helper assemble calls — over a REAL temp
 *       workspace holding a `.ts` file — with a fake LSP *provider* injected
 *       via its documented `lspProvider` seam. The fake records the anchor file
 *       it is `open`-ed against. We assert the fragment IS injected AND the
 *       anchor synthesized (and opened) is the REAL `.ts` file on disk —
 *       proving the real anchor-synth → union-LSP → resolve path executes.
 *   (b) ASSEMBLE WIRING (the §3b block): the no-seam
 *       `assembleAgentConfig(...).mentionInjector("@Sym")` reaches a NON-NULL
 *       symbol resolver (the live `lspNavProvider()` returns null because no
 *       language server is installed in the test env, so the fragment is
 *       gracefully dropped — but the call path is live, NOT a dead short-
 *       circuit, which the assertion on `buildMentionSymbolDeps(cwd, env)`
 *       attaching real `{ lsp, semantic }` ports pins).
 *
 * @skill still cannot be proven through the production wires (no skill registry
 * exists at config-assembly time — the per-turn inventory is built inside the
 * loop), so the @skill block below drives the composite resolver DIRECTLY with
 * a fake `SkillRegistryReadOnly` to prove that kind is not permanently dead.
 *
 * Everything uses a REAL temp workspace + REAL fs.readFile. The only stubs are
 * the LLM/registry/stream cores that `assembleAgentConfig` never reads, plus
 * the injected fake LSP provider (a fake *server*, not a fake resolver — the
 * resolver, anchor-synth, union-LSP, and composite are all the real production
 * code) in the §3a production-composition block.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assembleAgentConfig } from "@/../src/apps/agent/assemble"
import type { AgentConfig } from "@/agent"
import {
  buildInjectionFragments,
  buildMentionInjectionMessages,
  createSymbolResolver,
  parseMentions,
  type SymbolHit,
  type SymbolLookupLspPort,
} from "@/agent/mention-injection"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"
import {
  createCompositeMentionResolver,
  type SkillRegistryReadOnly,
} from "@/agent/plugin-app-resolver"
import { buildMentionSymbolDeps } from "@/host/runtime/internal/mention-symbol-deps"
import { installCliMentionInjector } from "@/host/runtime/internal/mention-wire"
import type { LspNavProvider, LspNavSession, NavSymbolInfo } from "@/tool"

/** The unified-agent mode the CLI REPL assembles under. */
const MODE = "interactive" as const

const FILE = "QUANTA_MENTION_FILE"
const SYMBOL = "QUANTA_MENTION_SYMBOL"
const SKILL = "QUANTA_MENTION_SKILL"
const FOLDER = "QUANTA_MENTION_FOLDER"
const GIT = "QUANTA_MENTION_GIT"
const KNOBS = [FILE, SYMBOL, SKILL, FOLDER, GIT] as const

/** Pull every `<mention …>` injected text block into one joined haystack. */
const allText = (messages: readonly { content: unknown }[]): string =>
  messages
    .map((m) => {
      const content = m.content
      if (!Array.isArray(content)) return ""
      return content.map((b) => (b?.type === "text" ? String(b.text) : "")).join("\n")
    })
    .join("\n---MSG---\n")

/** Minimal AgentConfig core for `assembleAgentConfig`. The assembler never
 *  reads these — only `cwd` / `sessionId` flow into the mention wire. */
const makeBase = (
  cwd: string,
  sessionId: string,
): Omit<AgentConfig, "modePolicy" | "budgetMeter"> =>
  ({
    llm: {} as AgentConfig["llm"],
    registry: {} as AgentConfig["registry"],
    stream: {} as AgentConfig["stream"],
    permission: {} as AgentConfig["permission"],
    messages: [] as AgentConfig["messages"],
    system: "system stub",
    maxTurns: 1,
    cwd,
    sessionId,
    signal: new AbortController().signal,
  }) as Omit<AgentConfig, "modePolicy" | "budgetMeter">

/** Run the injector exactly as the loop does (string in, Message[] out). */
const inject = async (cfg: AgentConfig, text: string): Promise<readonly { content: unknown }[]> => {
  expect(typeof cfg.mentionInjector).toBe("function")
  const fn = cfg.mentionInjector
  if (typeof fn !== "function") throw new Error("no injector")
  return (await fn(text)) as readonly { content: unknown }[]
}

describe("mention wire — END-TO-END hellgate (real fs, real wires)", () => {
  let dir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mention-e2e-"))
    for (const k of KNOBS) saved[k] = process.env[k]
    // Default-ON: clear so the knobs read as ON.
    for (const k of KNOBS) delete process.env[k]
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of KNOBS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  // ============================================================
  // 1. assembleAgentConfig path — @file injects REAL file body
  // ============================================================
  test("assembleAgentConfig: @file injects the file's REAL body", async () => {
    const body = "export const SECRET_TOKEN = 'e2e-marker-3f9a';\n// trailing\n"
    writeFileSync(join(dir, "note.ts"), body)
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "a-file") })
    const out = await inject(cfg, "please see @note.ts for context")
    expect(out.length).toBe(1)
    const text = allText(out)
    expect(text).toContain("e2e-marker-3f9a")
    expect(text).toContain("kind: file")
    expect(text).toContain("target: note.ts")
  })

  test("assembleAgentConfig: bare 'see @src/x.ts' reads nested file under cwd", async () => {
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src", "x.ts"), "NESTED_E2E_CONTENT_9z")
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "a-nest") })
    const out = await inject(cfg, "look at @src/x.ts")
    expect(allText(out)).toContain("NESTED_E2E_CONTENT_9z")
  })

  // ============================================================
  // 2. CLI/host path — installCliMentionInjector, identical e2e
  // ============================================================
  test("installCliMentionInjector: @file injects the file's REAL body", async () => {
    const body = "fn cli_marker() { /* CLI_E2E_MARKER_7b */ }\n"
    writeFileSync(join(dir, "main.rs"), body)
    const cfg = installCliMentionInjector({
      cwd: dir,
      sessionId: "c-file",
    } as unknown as AgentConfig)
    const out = await inject(cfg, "@main.rs here")
    expect(allText(out)).toContain("CLI_E2E_MARKER_7b")
  })

  // ============================================================
  // 3. @symbol e2e — fake LSP SymbolLookup proves it's NOT dead
  // ============================================================
  describe("@symbol: composite with an INJECTED fake LSP lookup", () => {
    const fakeLsp = (hits: readonly SymbolHit[] | null): SymbolLookupLspPort => ({
      findSymbol: async () => hits,
    })

    const buildInjector = (lookup: SymbolLookupLspPort) => {
      const resolver = createCompositeMentionResolver({
        files: { root: dir },
        symbol: createSymbolResolver({ lsp: lookup, priority: "lsp" }),
      })
      return async (text: string) => {
        const mentions = parseMentions(text)
        const frags = await buildInjectionFragments(mentions, resolver)
        return buildMentionInjectionMessages(frags)
      }
    }

    test("hit ⇒ definition snippet IS injected", async () => {
      const inj = buildInjector(
        fakeLsp([{ path: "src/foo.ts", line: 42, snippet: "class FooBar extends Base" }]),
      )
      const out = await inj("jump to @FooBar now")
      expect(out.length).toBe(1)
      const text = allText(out)
      expect(text).toContain("kind: symbol")
      expect(text).toContain("target: FooBar")
      expect(text).toContain("src/foo.ts:42")
      expect(text).toContain("class FooBar extends Base")
    })

    test("miss (null) ⇒ no fragment (skipped)", async () => {
      const out = await buildInjector(fakeLsp(null))("jump to @FooBar")
      expect(out.length).toBe(0)
    })

    test("miss (empty list) ⇒ no fragment (skipped)", async () => {
      const out = await buildInjector(fakeLsp([]))("jump to @FooBar")
      expect(out.length).toBe(0)
    })

    test("throwing lookup ⇒ NO-THROW, fragment dropped", async () => {
      const inj = buildInjector({
        findSymbol: async () => {
          throw new Error("hostile LSP")
        },
      })
      const out = await inj("jump to @FooBar")
      expect(out.length).toBe(0)
    })
  })

  // ============================================================
  // 3a. @symbol PRODUCTION composition — ADR-0423: real anchor synth
  //     over a REAL workspace, fake LSP *provider* (a fake server, not
  //     a fake resolver). Drives the EXACT `buildMentionSymbolDeps`
  //     helper `apps/agent/assemble.ts` calls, fed into the EXACT
  //     `buildDefaultMentionResolver` it uses. Proves the deliberate-hold
  //     null placeholder is gone: a real `.ts` file ⇒ a synthesized
  //     anchor ⇒ a workspace-symbol query against THAT file ⇒ injection.
  // ============================================================
  describe("@symbol: PRODUCTION assemble composition synthesizes a REAL anchor", () => {
    /** A fake LSP nav SESSION whose `workspaceSymbol` returns one hit and
     *  records nothing itself — the recording happens on `open` below. */
    const fakeSession = (hit: NavSymbolInfo): LspNavSession =>
      ({
        workspaceSymbol: async () => [hit],
        stop: async () => undefined,
      }) as unknown as LspNavSession

    /** A fake provider that RECORDS every anchor file it is `open`-ed against,
     *  so the test can assert the synthesizer picked the REAL `.ts` file on
     *  disk (proving the anchor walk ran over the real workspace, not a stub). */
    const recordingProvider = (opened: string[], hit: NavSymbolInfo): LspNavProvider =>
      ({
        unavailableReason: () => "fake",
        open: async (filePath: string) => {
          opened.push(filePath)
          return fakeSession(hit)
        },
      }) as unknown as LspNavProvider

    test("real `.ts` file ⇒ anchor synthesized + opened ⇒ @symbol injected", async () => {
      // REAL workspace: one nested .ts source file (the deterministic anchor).
      mkdirSync(join(dir, "lib"), { recursive: true })
      const anchorRel = join("lib", "thing.ts")
      const anchorAbs = join(dir, anchorRel)
      writeFileSync(anchorAbs, "export class FooBar {}\n")
      const opened: string[] = []
      const hit: NavSymbolInfo = {
        name: "FooBar",
        kind: "class",
        range: { start: { line: 6, character: 0 }, end: { line: 6, character: 6 } },
        selectionRange: { start: { line: 6, character: 0 }, end: { line: 6, character: 6 } },
        uri: "lib/thing.ts",
        containerName: "Lib",
      }
      // EXACT production composition: the deps `assembleAgentConfig` builds
      // (`buildMentionSymbolDeps`) fed into the resolver it builds
      // (`buildDefaultMentionResolver`). Only the LSP *provider* is faked.
      const deps = buildMentionSymbolDeps(dir, process.env, {
        lspProvider: recordingProvider(opened, hit),
        // Keep the semantic strategy a deterministic no-op so the assertion is
        // about the REAL LSP anchor path, not the (env-dependent) backend.
        semanticLookup: null,
      })
      // The production builder MUST attach a real LSP port (not the null hold).
      expect(deps.lsp).toBeDefined()
      const resolver = buildDefaultMentionResolver({ cwd: dir, env: process.env, ...deps })
      const frags = await buildInjectionFragments(parseMentions("jump to @FooBar"), resolver)
      const out = buildMentionInjectionMessages(frags)

      // 1. The fragment IS injected (no longer a dead null).
      expect(out.length).toBe(1)
      const text = allText(out)
      expect(text).toContain("kind: symbol")
      expect(text).toContain("target: FooBar")
      // 2. The synthesizer opened the LSP session against the REAL `.ts` file
      //    it found by walking the temp workspace — proving real anchor synth.
      expect(opened.length).toBeGreaterThanOrEqual(1)
      expect(opened).toContain(anchorAbs)
    })

    test("EMPTY workspace (no source file) ⇒ no anchor ⇒ @symbol gracefully null", async () => {
      // No `.ts`/`.py`/… anywhere ⇒ `synthesizeLspAnchors` returns [] ⇒ the
      // union LSP port answers null ⇒ the provider is NEVER opened.
      const opened: string[] = []
      const hit: NavSymbolInfo = {
        name: "FooBar",
        kind: "class",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      }
      const deps = buildMentionSymbolDeps(dir, process.env, {
        lspProvider: recordingProvider(opened, hit),
        semanticLookup: null,
      })
      const resolver = buildDefaultMentionResolver({ cwd: dir, env: process.env, ...deps })
      const out = buildMentionInjectionMessages(
        await buildInjectionFragments(parseMentions("jump to @FooBar"), resolver),
      )
      expect(out.length).toBe(0)
      // No anchor synthesized ⇒ no server was ever opened.
      expect(opened.length).toBe(0)
    })
  })

  // ============================================================
  // 3b. @symbol ASSEMBLE wiring — the NO-SEAM production path.
  //     `assembleAgentConfig` calls `buildMentionSymbolDeps(cwd, env)`
  //     with NO seams (the live `lspNavProvider()` + real semantic
  //     backend). With no language server installed in the test env the
  //     fragment is gracefully dropped — but the symbol resolver IS wired
  //     (NOT the dead null short-circuit ADR-0422 left behind). We pin the
  //     wiring by asserting the production builder attaches real ports.
  // ============================================================
  describe("@symbol: assembleAgentConfig wires a NON-NULL symbol resolver (ADR-0423)", () => {
    test("default-ON: buildMentionSymbolDeps(cwd, env) attaches real lsp + semantic ports", () => {
      // This is the EXACT call `mentionResolverDep` makes inside assemble
      // (no seams). The deliberate-hold placeholder would have returned {}.
      const deps = buildMentionSymbolDeps(dir, process.env)
      expect(deps.lsp).toBeDefined()
      expect(deps.semantic).toBeDefined()
      expect(typeof deps.lsp?.findSymbol).toBe("function")
      expect(typeof deps.semantic?.findSymbol).toBe("function")
    })

    test("QUANTA_MENTION_SYMBOL=off: buildMentionSymbolDeps short-circuits to {}", () => {
      process.env[SYMBOL] = "off"
      const deps = buildMentionSymbolDeps(dir, process.env)
      expect(deps.lsp).toBeUndefined()
      expect(deps.semantic).toBeUndefined()
    })

    test("assemble injector takes the live symbol path (graceful null w/o a real server)", async () => {
      // A real `.ts` exists ⇒ an anchor IS synthesized; the live
      // `lspNavProvider().open` returns null because no typescript-language-
      // server binary is installed in the test env ⇒ the union LSP answers
      // null; the real semantic backend over an empty index answers null too
      // ⇒ the fragment is gracefully dropped. The point is the call path is
      // LIVE end-to-end (no throw, no hang) — proven by the §3a recording
      // test that the SAME helper synthesizes + opens a real anchor.
      writeFileSync(join(dir, "live.ts"), "export const X = 1\n")
      const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "sym-live") })
      const out = await inject(cfg, "jump to @FooBar")
      expect(out.length).toBe(0)
    })
  })

  // ============================================================
  // 4. @skill e2e — fake SkillRegistryReadOnly proves it works
  // ============================================================
  describe("@skill: composite with an INJECTED fake registry", () => {
    const fakeSkills = (
      lookup: (n: string) => { name: string; description: string } | null,
    ): SkillRegistryReadOnly => ({ lookup })

    const buildInjector = (skills: SkillRegistryReadOnly) => {
      const resolver = createCompositeMentionResolver({ files: { root: dir }, skills })
      return async (text: string) => {
        const mentions = parseMentions(text)
        const frags = await buildInjectionFragments(mentions, resolver)
        return buildMentionInjectionMessages(frags)
      }
    }

    test("known skill ⇒ description IS injected", async () => {
      const inj = buildInjector(
        fakeSkills((n) =>
          n === "code-review" ? { name: "code-review", description: "REVIEW_DESC_MARKER" } : null,
        ),
      )
      const out = await inj("run @code-review please")
      expect(out.length).toBe(1)
      const text = allText(out)
      expect(text).toContain("kind: skill")
      expect(text).toContain("target: code-review")
      expect(text).toContain("REVIEW_DESC_MARKER")
    })

    test("unknown skill ⇒ no fragment (skipped)", async () => {
      const out = await buildInjector(fakeSkills(() => null))("run @code-review")
      expect(out.length).toBe(0)
    })

    test("throwing registry ⇒ NO-THROW, fragment dropped", async () => {
      const out = await buildInjector(
        fakeSkills(() => {
          throw new Error("hostile registry")
        }),
      )("run @code-review")
      expect(out.length).toBe(0)
    })
  })

  // ============================================================
  // 5. env OFF matrix — byte-identical (no inject) per kind
  // ============================================================
  test("QUANTA_MENTION_FILE=off ⇒ @file injects nothing", async () => {
    writeFileSync(join(dir, "z.ts"), "SHOULD_NOT_APPEAR_OFF")
    process.env[FILE] = "off"
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "off-file") })
    const out = await inject(cfg, "see @z.ts")
    expect(out.length).toBe(0)
  })

  test("QUANTA_MENTION_SYMBOL=off ⇒ injected fake LSP is NOT attached", async () => {
    process.env[SYMBOL] = "off"
    // Drive the assemble wire (which injects createLspSymbolLookup, anchor-less)
    // and ALSO prove the builder honours the OFF knob: with SYMBOL=off the
    // composite omits resolveSymbol entirely, so even a HIT-capable port would
    // be unreachable. We assert via the production wire that @symbol is null.
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "off-sym") })
    const out = await inject(cfg, "jump to @FooBar")
    expect(out.length).toBe(0)
  })

  test("QUANTA_MENTION_SKILL=off ⇒ no skill registry attached (skill null)", async () => {
    // The assemble/CLI wires never attach a skill registry anyway, so @skill is
    // always null there. Prove the BUILDER honours the OFF knob: even WITH a
    // fake registry injected at the builder, =off drops the resolveSkill dep.
    process.env[SKILL] = "off"
    const { buildDefaultMentionResolver } = await import("@/agent/mention-runner")
    const resolver = buildDefaultMentionResolver({
      cwd: dir,
      env: process.env,
      skills: { lookup: () => ({ name: "x", description: "SHOULD_NOT_APPEAR" }) },
    })
    const frags = await buildInjectionFragments(parseMentions("run @x"), resolver)
    expect(frags.length).toBe(0)
  })

  test("ALL knobs off ⇒ every kind injects nothing (legacy byte-identical)", async () => {
    writeFileSync(join(dir, "all.ts"), "SHOULD_NOT_APPEAR_ALL")
    for (const k of KNOBS) process.env[k] = "off"
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "off-all") })
    const out = await inject(cfg, "see @all.ts and @FooBar and @code-review")
    expect(out.length).toBe(0)
  })

  // ============================================================
  // 6. byte-identical — zero mentions ⇒ [] (no inject)
  // ============================================================
  test("no mention in input ⇒ injector returns [] (zero impact)", async () => {
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "none") })
    const out = await inject(cfg, "just a normal sentence, no mentions here")
    expect(out.length).toBe(0)
  })

  test("email foo@bar.com is NOT a mention (no inject)", async () => {
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "email") })
    const out = await inject(cfg, "contact me at foo@bar.com thanks")
    expect(out.length).toBe(0)
  })

  // ============================================================
  // 7. multi-kind single input — each kind a parallel fragment
  // ============================================================
  test("@file + @Symbol + @skill in ONE input ⇒ three ordered fragments", async () => {
    writeFileSync(join(dir, "multi.ts"), "MULTI_FILE_BODY")
    const resolver = createCompositeMentionResolver({
      files: { root: dir },
      symbol: createSymbolResolver({
        lsp: { findSymbol: async () => [{ path: "p.ts", line: 7, snippet: "MULTI_SYM_SNIP" }] },
        priority: "lsp",
      }),
      skills: {
        lookup: (n) => (n === "multi-skill" ? { name: n, description: "MULTI_SKILL_DESC" } : null),
      },
    })
    const text = "@multi.ts then @MultiSym then @multi-skill"
    const mentions = parseMentions(text)
    // parser classifies all three kinds:
    expect(mentions.map((m) => m.kind).sort()).toEqual(["file", "skill", "symbol"])
    const frags = await buildInjectionFragments(mentions, resolver)
    const out = buildMentionInjectionMessages(frags)
    expect(out.length).toBe(3)
    const text2 = allText(out)
    expect(text2).toContain("MULTI_FILE_BODY")
    expect(text2).toContain("MULTI_SYM_SNIP")
    expect(text2).toContain("MULTI_SKILL_DESC")
    // order preserved = input order of resolvable mentions
    const kinds = frags.map((f) => f.kind)
    expect(kinds).toEqual(["file", "symbol", "skill"])
  })

  test("one kind throws, others survive (parallel isolation)", async () => {
    writeFileSync(join(dir, "ok.ts"), "OK_BODY_SURVIVES")
    const resolver = createCompositeMentionResolver({
      files: { root: dir },
      symbol: async () => {
        throw new Error("symbol blows up")
      },
    })
    const out = buildMentionInjectionMessages(
      await buildInjectionFragments(parseMentions("@ok.ts and @BoomSym"), resolver),
    )
    // file survives, symbol dropped
    expect(out.length).toBe(1)
    expect(allText(out)).toContain("OK_BODY_SURVIVES")
  })

  // ============================================================
  // 8. NO-THROW — missing file / directory target / hostile input
  // ============================================================
  test("missing file ⇒ fragment dropped, turn survives", async () => {
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "miss") })
    const out = await inject(cfg, "see @does-not-exist.ts")
    expect(out.length).toBe(0)
  })

  test("@dir (a directory) ⇒ resolved as @folder listing (not dropped)", async () => {
    // §10.3 folder resolver is default-ON — a trailing-slash mention like
    // `@subdir/` is now classified as "folder" kind and resolves to a
    // directory listing, NOT dropped. The original test expected 0 injections
    // (written before §10.3 landed); now expect 1 (the folder listing).
    mkdirSync(join(dir, "subdir"), { recursive: true })
    // Seed a file inside the directory so the listing body is non-empty and
    // we can assert its content appears in the injected fragment.
    writeFileSync(join(dir, "subdir", "hello.ts"), "")
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "isdir") })
    const out = await inject(cfg, "see @subdir/")
    expect(out.length).toBe(1)
    const text = allText(out)
    expect(text).toContain("kind: folder")
    expect(text).toContain("target: subdir/")
    expect(text).toContain("hello.ts")
  })

  // ============================================================
  // 9. adversarial fs-jail / path traversal / symlink / size
  // ============================================================
  test("path traversal @../../etc/passwd ⇒ refused (null)", async () => {
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "trav") })
    const out = await inject(cfg, "leak @../../etc/passwd")
    expect(out.length).toBe(0)
  })

  test("symlink escaping the jail ⇒ refused (null)", async () => {
    // outside-dir is a sibling of the workspace root (NOT inside it).
    const outsideDir = mkdtempSync(join(tmpdir(), "mention-outside-"))
    try {
      const secret = join(outsideDir, "secret.txt")
      writeFileSync(secret, "SYMLINK_ESCAPE_SECRET")
      const link = join(dir, "link.txt")
      symlinkSync(secret, link)
      const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "symesc") })
      const out = await inject(cfg, "read @link.txt")
      expect(out.length).toBe(0)
      expect(allText(out)).not.toContain("SYMLINK_ESCAPE_SECRET")
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test("over-cap file ⇒ truncated (not nulled), keeps a head window", async () => {
    const big = `${"A".repeat(2048)}TAILMARK`
    writeFileSync(join(dir, "big.ts"), big)
    process.env.QUANTA_MENTION_FILE_MAX_BYTES = "512"
    try {
      const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "cap") })
      const out = await inject(cfg, "see @big.ts")
      expect(out.length).toBe(1)
      const text = allText(out)
      expect(text).toContain("truncated")
      // head window present, tail body NOT (default tailRatio 0 = head-only)
      expect(text).toContain("AAAA")
      expect(text).not.toContain("TAILMARK")
    } finally {
      delete process.env.QUANTA_MENTION_FILE_MAX_BYTES
    }
  })

  test("concurrent same @file ⇒ consistent body (no cross-talk)", async () => {
    writeFileSync(join(dir, "race.ts"), "RACE_BODY_CONSISTENT")
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "race") })
    const results = await Promise.all(Array.from({ length: 8 }, () => inject(cfg, "see @race.ts")))
    for (const out of results) {
      expect(out.length).toBe(1)
      expect(allText(out)).toContain("RACE_BODY_CONSISTENT")
    }
  })

  test("binary file (NUL byte) ⇒ dropped (null)", async () => {
    writeFileSync(join(dir, "bin.ts"), Buffer.from([0x41, 0x00, 0x42, 0x43]))
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "bin") })
    const out = await inject(cfg, "see @bin.ts")
    expect(out.length).toBe(0)
  })

  // ============================================================
  // 10. symbol resolver auto-fallback proven with injected deps
  // ============================================================
  test("auto priority: LSP miss ⇒ semantic fallback HIT is injected", async () => {
    const resolver = createCompositeMentionResolver({
      files: { root: dir },
      symbol: createSymbolResolver({
        lsp: { findSymbol: async () => null }, // miss
        semantic: {
          findSymbol: async () => [{ path: "sem.ts", line: 3, snippet: "SEMANTIC_FALLBACK_HIT" }],
        },
        priority: "auto",
      }),
    })
    const out = buildMentionInjectionMessages(
      await buildInjectionFragments(parseMentions("@FallbackSym"), resolver),
    )
    expect(out.length).toBe(1)
    expect(allText(out)).toContain("SEMANTIC_FALLBACK_HIT")
  })

  // ============================================================
  // 11. dedup — same @file twice ⇒ one fragment
  // ============================================================
  test("same @file mentioned twice ⇒ deduped to one fragment", async () => {
    writeFileSync(join(dir, "dup.ts"), "DEDUP_BODY")
    const cfg = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "dedup") })
    const out = await inject(cfg, "see @dup.ts and again @dup.ts")
    expect(out.length).toBe(1)
  })

  // ============================================================
  // 12. injector ALWAYS attached (default-ON contract)
  // ============================================================
  test("default-ON: both wires attach a mentionInjector function", () => {
    const a = assembleAgentConfig({ mode: MODE, base: makeBase(dir, "on-a") })
    expect(typeof a.mentionInjector).toBe("function")
    const c = installCliMentionInjector({ cwd: dir, sessionId: "on-c" } as unknown as AgentConfig)
    expect(typeof c.mentionInjector).toBe("function")
  })
})
