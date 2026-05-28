/**
 * ADR-0422 — `buildDefaultMentionResolver` hellgate.
 *
 * The builder reads `QUANTA_MENTION_*` env knobs (default-ON) and composes a
 * `MentionResolverPort` from whatever deps the surface supplies. Tests assert
 * the env gate matrix + graceful omit + byte-identical (all off).
 *
 *   A. env gate 3×3 — FILE / SYMBOL / SKILL each ON vs =off               (6)
 *   B. graceful omit — knob ON but dep absent ⇒ kind not wired           (3)
 *   C. byte-identical — every knob off ⇒ no file/symbol method, skill null (2)
 *   D. byte-identical — every dep absent (knobs default-ON) ⇒ same        (1)
 *   E. file caps env mapped onto the file resolver options                (1)
 *   F. symbol strategy/timeout env honoured (lsp-only priority)           (2)
 *   G. @skill hit ⇒ first-line body; miss ⇒ null                          (2)
 *
 * Total = 17 cases. Symbol lookup ports + skill registry are fakes.
 */

import { describe, expect, test } from "bun:test"
import type {
  SymbolHit,
  SymbolLookupLspPort,
  SymbolLookupSemanticPort,
} from "@/agent/mention-injection"
import type { SkillRegistryReadOnly } from "@/agent/plugin-app-resolver"
import { buildDefaultMentionResolver, type MentionEnv } from "../default-resolver"

const lsp = (
  fn: (n: string) => Promise<readonly SymbolHit[] | null> = async () => [{ path: "x.ts", line: 1 }],
): SymbolLookupLspPort => ({ findSymbol: fn })
const sem = (
  fn: (n: string) => Promise<readonly SymbolHit[] | null> = async () => [{ path: "y.ts", line: 2 }],
): SymbolLookupSemanticPort => ({ findSymbol: fn })

const reg = (entries: Record<string, string>): SkillRegistryReadOnly => ({
  lookup: (name) => {
    const desc = entries[name]
    return desc === undefined ? null : { name, description: desc }
  },
})

const env = (over: Record<string, string | undefined> = {}): MentionEnv => over

describe("buildDefaultMentionResolver — ADR-0422 hellgate", () => {
  // -------- A. env gate 3×3 ------------------------------------------
  test("A1 — FILE ON ⇒ resolveFile attached", () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env() })
    expect(typeof r.resolveFile).toBe("function")
  })

  test("A2 — FILE=off ⇒ resolveFile NOT attached", () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({ QUANTA_MENTION_FILE: "off" }),
    })
    expect(r.resolveFile).toBeUndefined()
  })

  test("A3 — SYMBOL ON + port ⇒ resolveSymbol attached", () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env(), lsp: lsp() })
    expect(typeof r.resolveSymbol).toBe("function")
  })

  test("A4 — SYMBOL=off (port present) ⇒ resolveSymbol NOT attached", () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({ QUANTA_MENTION_SYMBOL: "off" }),
      lsp: lsp(),
    })
    expect(r.resolveSymbol).toBeUndefined()
  })

  test("A5 — SKILL ON + registry ⇒ resolveSkill resolves a hit", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(),
      skills: reg({ "code-review": "Review the diff\nmore" }),
    })
    expect((await r.resolveSkill("code-review"))?.bodyText).toBe("Review the diff")
  })

  test("A6 — SKILL=off (registry present) ⇒ resolveSkill resolves null", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({ QUANTA_MENTION_SKILL: "off" }),
      skills: reg({ "code-review": "Review the diff" }),
    })
    expect(await r.resolveSkill("code-review")).toBeNull()
  })

  // -------- B. graceful omit -----------------------------------------
  test("B1 — SYMBOL ON but no port ⇒ resolveSymbol NOT attached", () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env() })
    expect(r.resolveSymbol).toBeUndefined()
  })

  test("B2 — SKILL ON but no registry ⇒ resolveSkill resolves null", async () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env() })
    expect(await r.resolveSkill("code-review")).toBeNull()
  })

  test("B3 — semantic-only port still wires resolveSymbol", () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env(), semantic: sem() })
    expect(typeof r.resolveSymbol).toBe("function")
  })

  // -------- C. byte-identical: every knob off ------------------------
  test("C1 — all knobs off ⇒ no file/symbol method", () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({
        QUANTA_MENTION_FILE: "off",
        QUANTA_MENTION_SYMBOL: "off",
        QUANTA_MENTION_SKILL: "off",
      }),
      lsp: lsp(),
      semantic: sem(),
      skills: reg({ a: "A" }),
    })
    expect(r.resolveFile).toBeUndefined()
    expect(r.resolveSymbol).toBeUndefined()
  })

  test("C2 — all knobs off ⇒ skill resolves null (legacy 3-kind null shape)", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({
        QUANTA_MENTION_FILE: "off",
        QUANTA_MENTION_SYMBOL: "off",
        QUANTA_MENTION_SKILL: "off",
      }),
      skills: reg({ a: "A" }),
    })
    expect(await r.resolveSkill("a")).toBeNull()
  })

  // -------- D. byte-identical: every dep absent ----------------------
  test("D1 — knobs default-ON but all deps absent ⇒ symbol omitted, skill null", async () => {
    const r = buildDefaultMentionResolver({ cwd: "/repo", env: env() })
    expect(r.resolveSymbol).toBeUndefined()
    expect(await r.resolveSkill("a")).toBeNull()
    // @file is always wirable (root = cwd), so resolveFile IS attached.
    expect(typeof r.resolveFile).toBe("function")
  })

  // -------- E. file caps env mapping ---------------------------------
  test("E1 — file caps env produce a working file resolver", async () => {
    // Point root at a real tmp dir and read a file via the resolver.
    const dir = await import("node:fs/promises").then((m) =>
      m.mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/mention-`),
    )
    const fs = await import("node:fs/promises")
    await fs.writeFile(`${dir}/note.txt`, "hello world", "utf8")
    const r = buildDefaultMentionResolver({
      cwd: dir,
      env: env({ QUANTA_MENTION_FILE_MAX_BYTES: "100000", QUANTA_MENTION_FILE_TAIL_RATIO: "0.5" }),
    })
    const res = await r.resolveFile?.("note.txt")
    expect(res?.bodyText).toContain("hello world")
    await fs.rm(dir, { recursive: true, force: true })
  })

  // -------- F. symbol strategy / timeout env -------------------------
  test("F1 — QUANTA_MENTION_SYMBOL_RESOLVER=lsp uses ONLY lsp (semantic untouched)", async () => {
    let semCalled = 0
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({ QUANTA_MENTION_SYMBOL_RESOLVER: "lsp" }),
      lsp: lsp(async () => [{ path: "z.ts", line: 7, snippet: "Foo" }]),
      semantic: sem(async () => {
        semCalled += 1
        return [{ path: "y.ts", line: 2 }]
      }),
    })
    const res = await r.resolveSymbol?.("Foo")
    expect(res?.bodyText).toContain("z.ts:7")
    expect(semCalled).toBe(0)
  })

  test("F2 — QUANTA_MENTION_SYMBOL_RESOLVER=semantic uses ONLY semantic", async () => {
    let lspCalled = 0
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env({ QUANTA_MENTION_SYMBOL_RESOLVER: "semantic" }),
      lsp: lsp(async () => {
        lspCalled += 1
        return [{ path: "z.ts", line: 7 }]
      }),
      semantic: sem(async () => [{ path: "y.ts", line: 2, snippet: "Bar" }]),
    })
    const res = await r.resolveSymbol?.("Bar")
    expect(res?.bodyText).toContain("y.ts:2")
    expect(lspCalled).toBe(0)
  })

  // -------- G. skill hit / miss --------------------------------------
  test("G1 — @skill hit ⇒ first-line body", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(),
      skills: reg({ verify: "Run the app and observe\nlong details" }),
    })
    expect((await r.resolveSkill("verify"))?.bodyText).toBe("Run the app and observe")
  })

  test("G2 — @skill miss ⇒ null", async () => {
    const r = buildDefaultMentionResolver({
      cwd: "/repo",
      env: env(),
      skills: reg({ verify: "..." }),
    })
    expect(await r.resolveSkill("nope")).toBeNull()
  })
})
