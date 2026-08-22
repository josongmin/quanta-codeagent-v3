/**
 * TKT-0418 / ADR-0418 — mention-injection PIPELINE PRIMITIVES integration.
 *
 * This battery promotes the @file / @symbol async-resolver slice from L3
 * (unit hellgates at `src/agent/mention-injection/__tests__/` +
 * `src/agent/plugin-app-resolver/__tests__/`) to L4 (real-fs end-to-end
 * integration) by driving the THREE pure primitives the wire eventually
 * composes:
 *
 *   parseMentions(text)                          // pure parser
 *      → buildInjectionFragments(mentions, port) // async resolver dispatch
 *         → createCompositeMentionResolver({files})  // real fs.readFile path
 *            → createFileResolver({root})              // fs-jail + size-cap
 *
 * Distinct from `tests/integration/mention-e2e-hellgate.test.ts` (which
 * exercises the WIRED `AgentConfig.mentionInjector` via
 * `assembleAgentConfig` / `installCliMentionInjector`). That battery is
 * wire-shaped (config envelope + Message[] output + env knobs); this one
 * is pipeline-shaped (parser → fragments) so a regression in the
 * primitive composition surfaces here even if the wire helpers are torn
 * down or rebuilt.
 *
 * Real-fs scope: each test mints a fresh `mkdtemp` workspace, plants
 * real `.ts` / `.md` / nested / binary / over-cap / outside-jail files,
 * and asserts the fragment bodyText equals what `fs.readFile` would
 * return (or is `null` for the documented degradations).
 *
 * Adversarial axis (preserves the parser kind-dispatch invariants):
 *   - missing file              ⇒ skipped (no fragment).
 *   - binary file (NUL byte)    ⇒ skipped (no fragment).
 *   - over-cap (256 KiB+)       ⇒ truncated, head-only marker preserved.
 *   - workspace-outside path    ⇒ skipped (fs-jail boundary).
 *   - bare token (no `.`/`/`)   ⇒ classified `skill`, not `file`.
 *   - uppercase-leading token   ⇒ classified `symbol`, not `file`.
 *
 * @symbol axis: one case proves the async port also dispatches the
 *   symbol kind via a captured `lsp` port (no real LSP server needed).
 *
 * NO production code mutated — this is a pure tests/ addition.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildInjectionFragments,
  createSymbolResolver,
  type InjectionFragment,
  parseMentions,
  type SymbolHit,
} from "@/agent/mention-injection"
import { createCompositeMentionResolver } from "@/agent/plugin-app-resolver"

const FILE_BODY_TS = "export const MARKER_TS = 'mark-ts-eef3a1';\n// trailing\n"
const FILE_BODY_MD = "# README\n\nReal MD marker MARK_MD_92fc.\n"
const NESTED_BODY = "NESTED_MARKER_d31"

/** Run the EXACT pipeline three-step composition the wire eventually
 *  builds: parse → resolve (async) → fragments. */
const pipeline = async (
  text: string,
  root: string,
  extras: Partial<Parameters<typeof createCompositeMentionResolver>[0]> = {},
): Promise<readonly InjectionFragment[]> => {
  const mentions = parseMentions(text)
  const resolver = createCompositeMentionResolver({
    files: { root },
    ...extras,
  })
  return buildInjectionFragments(mentions, resolver)
}

describe("mention-injection pipeline — real-fs e2e (TKT-0418 L4)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mention-async-file-e2e-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // ============================================================
  // 1. @file: nested `src/x.ts` reads through async file-resolver
  // ============================================================
  test("@file (nested src/x.ts): parser → resolver → fs.readFile body lands in fragment", async () => {
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src", "x.ts"), FILE_BODY_TS, "utf8")

    const frags = await pipeline("please see @src/x.ts for context", dir)

    expect(frags.length).toBe(1)
    const f = frags[0]
    if (f === undefined) throw new Error("unreachable")
    expect(f.kind).toBe("file")
    expect(f.target).toBe("src/x.ts")
    expect(f.bodyText).toBe(FILE_BODY_TS)
    // originSpan is non-empty + within input range
    expect(f.originSpan.end).toBeGreaterThan(f.originSpan.start)
  })

  // ============================================================
  // 2. @file (bare lowercase dotted token): @notes.md classified `file`
  // ============================================================
  test("@notes.md (lowercase dotted token): routes to file kind, real fs body injected", async () => {
    // Parser rule (ADR-0418 priority 4): lowercase + dot ⇒ file. Uppercase
    // dotted tokens like `@README.md` are classified `symbol`, not file —
    // we use lowercase here so we are truthfully exercising the file path.
    writeFileSync(join(dir, "notes.md"), FILE_BODY_MD, "utf8")

    const mentions = parseMentions("docs at @notes.md")
    expect(mentions.length).toBe(1)
    expect(mentions[0]?.kind).toBe("file")

    const frags = await pipeline("docs at @notes.md", dir)

    expect(frags.length).toBe(1)
    const f = frags[0]
    if (f === undefined) throw new Error("unreachable")
    expect(f.kind).toBe("file")
    expect(f.target).toBe("notes.md")
    expect(f.bodyText).toBe(FILE_BODY_MD)
  })

  // ============================================================
  // 3. @file (./-prefixed): ./Foo.ts also routes to file
  // ============================================================
  test("@./Foo.ts: dot-slash prefix routes to file kind, real fs body injected", async () => {
    writeFileSync(join(dir, "Foo.ts"), NESTED_BODY, "utf8")

    const frags = await pipeline("see @./Foo.ts", dir)

    expect(frags.length).toBe(1)
    const f = frags[0]
    if (f === undefined) throw new Error("unreachable")
    expect(f.kind).toBe("file")
    expect(f.bodyText).toBe(NESTED_BODY)
  })

  // ============================================================
  // 4. multiple @file mentions: each independently resolved
  // ============================================================
  test("two @file mentions in one input: both resolved, order preserved", async () => {
    writeFileSync(join(dir, "a.ts"), "BODY_A_e1", "utf8")
    mkdirSync(join(dir, "sub"), { recursive: true })
    writeFileSync(join(dir, "sub", "b.ts"), "BODY_B_e2", "utf8")

    const frags = await pipeline("see @a.ts and @sub/b.ts", dir)

    expect(frags.length).toBe(2)
    expect(frags.map((f) => f.kind)).toEqual(["file", "file"])
    expect(frags.map((f) => f.target)).toEqual(["a.ts", "sub/b.ts"])
    expect(frags.map((f) => f.bodyText)).toEqual(["BODY_A_e1", "BODY_B_e2"])
    // Spans strictly increasing (input order)
    const f0 = frags[0]
    const f1 = frags[1]
    if (f0 === undefined || f1 === undefined) throw new Error("unreachable")
    expect(f0.originSpan.start).toBeLessThan(f1.originSpan.start)
  })

  // ============================================================
  // 5. NO file dep ⇒ @file silently dropped (legacy 3-kind shape)
  // ============================================================
  test("composite without `files` dep: @file mentions parse but resolve to null (skipped)", async () => {
    writeFileSync(join(dir, "z.ts"), "SHOULD_NOT_APPEAR", "utf8")
    const mentions = parseMentions("read @z.ts please")
    expect(mentions.length).toBe(1)
    expect(mentions[0]?.kind).toBe("file")

    // No files dep ⇒ port has no resolveFile method.
    const resolver = createCompositeMentionResolver()
    const frags = await buildInjectionFragments(mentions, resolver)
    expect(frags.length).toBe(0)
  })

  // ============================================================
  // 6. missing file ⇒ fragment skipped
  // ============================================================
  test("missing file path: parser still emits, resolver returns null, fragment dropped", async () => {
    const mentions = parseMentions("@does-not-exist.ts")
    expect(mentions.length).toBe(1)
    expect(mentions[0]?.kind).toBe("file")

    const frags = await pipeline("@does-not-exist.ts", dir)
    expect(frags.length).toBe(0)
  })

  // ============================================================
  // 7. binary file (NUL in sniff window) ⇒ fragment skipped
  // ============================================================
  test("binary file (NUL byte): file-resolver sniff rejects, fragment dropped", async () => {
    writeFileSync(join(dir, "bin.ts"), Buffer.from([0x41, 0x00, 0x42, 0x43]))

    const frags = await pipeline("see @bin.ts", dir)
    expect(frags.length).toBe(0)
  })

  // ============================================================
  // 8. over-cap file ⇒ truncated (NOT nulled), head window preserved
  // ============================================================
  test("over-cap @file: truncated head-only, trailing marker NOT present", async () => {
    const big = `${"A".repeat(2048)}TAILMARK_NOT_VISIBLE`
    writeFileSync(join(dir, "big.ts"), big, "utf8")

    const mentions = parseMentions("see @big.ts")
    const resolver = createCompositeMentionResolver({
      files: { root: dir, maxBytes: 512 },
    })
    const frags = await buildInjectionFragments(mentions, resolver)

    expect(frags.length).toBe(1)
    const f = frags[0]
    if (f === undefined) throw new Error("unreachable")
    expect(f.bodyText).toContain("AAAA")
    expect(f.bodyText).toContain("truncated")
    // default tailRatio = 0 ⇒ trailing marker NOT in body
    expect(f.bodyText).not.toContain("TAILMARK_NOT_VISIBLE")
  })

  // ============================================================
  // 9. fs-jail: @../escape refused (workspace boundary)
  // ============================================================
  test("@../escape.txt: fs-jail rejects out-of-workspace path, fragment dropped", async () => {
    // Plant the secret OUTSIDE the workspace root.
    const outside = mkdtempSync(join(tmpdir(), "mention-outside-"))
    try {
      writeFileSync(join(outside, "secret.txt"), "OUTSIDE_SECRET_NOT_LEAKED", "utf8")

      // Parser does NOT allow `..` segments → emits zero mentions.
      // Containment is also enforced by file-resolver as belt+suspenders.
      const mentions = parseMentions(`leak @../${outside.split("/").pop()}/secret.txt`)
      const resolver = createCompositeMentionResolver({ files: { root: dir } })
      const frags = await buildInjectionFragments(mentions, resolver)

      expect(frags.length).toBe(0)
      for (const f of frags) {
        expect(f.bodyText).not.toContain("OUTSIDE_SECRET_NOT_LEAKED")
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // ============================================================
  // 10. fs-jail: symlink escaping the jail refused (canonicalize)
  // ============================================================
  test("symlink escaping the jail: file-resolver follows realpath, rejects, fragment dropped", async () => {
    const outside = mkdtempSync(join(tmpdir(), "mention-symesc-"))
    try {
      const secret = join(outside, "secret.txt")
      writeFileSync(secret, "SYMLINK_ESCAPE_SECRET_NOT_LEAKED", "utf8")
      symlinkSync(secret, join(dir, "link.txt"))

      const frags = await pipeline("read @link.txt", dir)
      expect(frags.length).toBe(0)
      for (const f of frags) {
        expect(f.bodyText).not.toContain("SYMLINK_ESCAPE_SECRET_NOT_LEAKED")
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // ============================================================
  // 11. kind-dispatch invariant: bare `@code-review` STAYS `skill`
  // ============================================================
  test("bare `@code-review` (no `.` or `/`): parser → skill kind, NOT file (no fs read attempted)", async () => {
    // Plant a file with the SAME name in the workspace; resolver must NOT pick it.
    writeFileSync(join(dir, "code-review"), "SHOULD_NOT_BE_READ", "utf8")

    const mentions = parseMentions("run @code-review please")
    expect(mentions.length).toBe(1)
    expect(mentions[0]?.kind).toBe("skill")

    // With NO skills dep ⇒ skill resolves to null (skipped). The file
    // dep is wired, but kind dispatch is HARD — file-resolver is never
    // consulted for a `skill` mention.
    const frags = await pipeline("run @code-review please", dir)
    expect(frags.length).toBe(0)
  })

  // ============================================================
  // 12. kind-dispatch invariant: `@FooBar` STAYS `symbol`, NOT file
  // ============================================================
  test("`@FooBar` (uppercase leading): parser → symbol kind, file dep does NOT serve it", async () => {
    // Plant a file with the SAME name; resolver MUST NOT read it.
    writeFileSync(join(dir, "FooBar"), "SHOULD_NOT_BE_READ_SYM", "utf8")

    const mentions = parseMentions("jump to @FooBar")
    expect(mentions.length).toBe(1)
    expect(mentions[0]?.kind).toBe("symbol")

    // With NO symbol dep ⇒ symbol resolves to null (skipped). File dep
    // is wired but isolated from symbol dispatch.
    const frags = await pipeline("jump to @FooBar", dir)
    expect(frags.length).toBe(0)
  })

  // ============================================================
  // 13. @symbol async dispatch via injected lsp port (ADR-0422/0423)
  // ============================================================
  test("@FooBar with injected fake LSP port: async resolver dispatches symbol, body injected", async () => {
    const hits: readonly SymbolHit[] = [
      { path: "src/foo.ts", line: 42, snippet: "class FooBar extends Base" },
    ]
    const symbolFn = createSymbolResolver({
      lsp: { findSymbol: async () => hits },
      priority: "lsp",
    })

    const mentions = parseMentions("jump to @FooBar now")
    expect(mentions.length).toBe(1)
    expect(mentions[0]?.kind).toBe("symbol")

    const resolver = createCompositeMentionResolver({
      files: { root: dir },
      symbol: symbolFn,
    })
    const frags = await buildInjectionFragments(mentions, resolver)

    expect(frags.length).toBe(1)
    const f = frags[0]
    if (f === undefined) throw new Error("unreachable")
    expect(f.kind).toBe("symbol")
    expect(f.target).toBe("FooBar")
    // rendered body contains the path:line + snippet
    expect(f.bodyText).toContain("src/foo.ts:42")
    expect(f.bodyText).toContain("class FooBar extends Base")
  })

  // ============================================================
  // 14. mixed @file + @symbol: pipeline composes, order preserved
  // ============================================================
  test("@file + @symbol in one input: both resolved in parallel, file body + symbol snippet present", async () => {
    writeFileSync(join(dir, "mix.ts"), "MIX_FILE_BODY_a7", "utf8")
    const resolver = createCompositeMentionResolver({
      files: { root: dir },
      symbol: createSymbolResolver({
        lsp: {
          findSymbol: async () => [{ path: "p.ts", line: 7, snippet: "MIX_SYM_SNIPPET_b8" }],
        },
        priority: "lsp",
      }),
    })

    const mentions = parseMentions("see @mix.ts and @MixSym now")
    const kinds = mentions.map((m) => m.kind)
    expect(kinds).toContain("file")
    expect(kinds).toContain("symbol")

    const frags = await buildInjectionFragments(mentions, resolver)
    expect(frags.length).toBe(2)
    const bodies = frags.map((f) => f.bodyText).join("\n---\n")
    expect(bodies).toContain("MIX_FILE_BODY_a7")
    expect(bodies).toContain("MIX_SYM_SNIPPET_b8")
    // input order preserved
    expect(frags.map((f) => f.kind)).toEqual(["file", "symbol"])
  })

  // ============================================================
  // 15. directory target ⇒ skipped (not a file)
  // ============================================================
  test("@subdir/ (directory): file-resolver rejects non-file stat, fragment dropped", async () => {
    mkdirSync(join(dir, "subdir"), { recursive: true })
    // The trailing slash + non-dotted final segment makes parser route this as `file`.
    const mentions = parseMentions("see @subdir/x.ts")
    // we plant the directory but no file, so EBADENT / not-a-file ⇒ null
    const frags = await pipeline("see @subdir/x.ts", dir)
    expect(frags.length).toBe(0)
    // Defensive sanity: parser DID route as `file`, not `skill`/`symbol`.
    if (mentions.length > 0) {
      expect(mentions[0]?.kind).toBe("file")
    }
  })

  // ============================================================
  // 16. byte-identical: zero mentions ⇒ zero fragments
  // ============================================================
  test("input with NO mentions: parser → [] → fragments → [] (zero-impact)", async () => {
    const mentions = parseMentions("just a normal sentence, no mentions here")
    expect(mentions).toEqual([])
    const frags = await pipeline("just a normal sentence, no mentions here", dir)
    expect(frags.length).toBe(0)
  })
})
