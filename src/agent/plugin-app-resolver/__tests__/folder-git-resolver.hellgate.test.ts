/**
 * §10.3 — folder + git resolver impls + composite dispatch hellgate.
 *
 * Covers:
 *   A. folder resolver — jailed listing, sort, entry-cap, non-dir/escape null  (7)
 *   B. git resolver — subcommand dispatch, byte-cap, blank/clean-tree null      (6)
 *   C. composite dispatch — folder/git attach only when dep supplied            (4)
 *   D. byte-identity — omitting folders/git ⇒ no port keys (legacy shape)       (2)
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { buildInjectionFragments, type ParsedMention } from "@/agent/mention-injection"
import {
  createCompositeMentionResolver,
  createFolderResolver,
  createGitResolver,
  type GitContextProvider,
} from "@/agent/plugin-app-resolver"

// ── temp workspace fixture ───────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "folder-git-res-"))
mkdirSync(join(root, "src"))
writeFileSync(join(root, "src", "b.ts"), "b")
writeFileSync(join(root, "src", "a.ts"), "a")
mkdirSync(join(root, "src", "nested"))
writeFileSync(join(root, "top.md"), "top")

afterAll(() => {
  // best-effort cleanup; tmpdir is reaped anyway
})

const mention = (kind: ParsedMention["kind"], target: string): ParsedMention => ({
  kind,
  target,
  span: { start: 0, end: target.length + 1 },
  raw: `@${target}`,
})

// ── A. folder resolver ───────────────────────────────────────────────────
describe("§10.3 folder resolver", () => {
  test("A1 — lists directory entries (dirs suffixed with /)", async () => {
    const r = createFolderResolver({ root })
    const out = await r("src")
    expect(out).not.toBeNull()
    expect(out?.bodyText).toBe(["a.ts", "b.ts", "nested/"].join("\n"))
  })

  test("A2 — listing is byte-sorted deterministically", async () => {
    const r = createFolderResolver({ root })
    const out = await r("src")
    const lines = out?.bodyText.split("\n") ?? []
    expect(lines).toEqual([...lines].sort())
  })

  test("A3 — entry cap truncates with a +N marker", async () => {
    const r = createFolderResolver({ root, maxEntries: 1 })
    const out = await r("src")
    expect(out?.bodyText).toContain("(+2 more)")
  })

  test("A4 — non-directory target ⇒ null", async () => {
    const r = createFolderResolver({ root })
    expect(await r("top.md")).toBeNull()
  })

  test("A5 — missing target ⇒ null", async () => {
    const r = createFolderResolver({ root })
    expect(await r("does-not-exist")).toBeNull()
  })

  test("A6 — fs-jail: absolute escape outside root ⇒ null", async () => {
    const r = createFolderResolver({ root })
    expect(await r("/etc")).toBeNull()
  })

  test("A7 — empty / non-string target ⇒ null (no throw)", async () => {
    const r = createFolderResolver({ root })
    expect(await r("")).toBeNull()
    // @ts-expect-error runtime guard
    expect(await r(undefined)).toBeNull()
  })
})

// ── B. git resolver ──────────────────────────────────────────────────────
describe("§10.3 git resolver", () => {
  const provider: GitContextProvider = async (sub) => {
    if (sub === "status") return "M src/a.ts\n?? new.txt"
    if (sub === "diff") return "diff --git a/x b/x\n+added"
    if (sub === "log") return "abc123 first commit"
    return null
  }

  test("B1 — status subcommand returns status body", async () => {
    const r = createGitResolver({ provider })
    const out = await r("status")
    expect(out?.bodyText).toContain("M src/a.ts")
  })

  test("B2 — diff subcommand returns diff body", async () => {
    const r = createGitResolver({ provider })
    expect((await r("diff"))?.bodyText).toContain("+added")
  })

  test("B3 — unknown subcommand ⇒ null (closed enum, no fallback)", async () => {
    const r = createGitResolver({ provider })
    expect(await r("bogus")).toBeNull()
  })

  test("B4 — blank provider result (clean tree) ⇒ null", async () => {
    const r = createGitResolver({ provider: async () => "   \n  " })
    expect(await r("status")).toBeNull()
  })

  test("B5 — over-cap body is truncated on a line boundary", async () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    const r = createGitResolver({ provider: async () => big, maxBytes: 20 })
    const out = await r("log")
    expect(out?.bodyText).toContain("git context truncated")
    expect(out?.bodyText.length).toBeLessThan(big.length)
  })

  test("B6 — throwing provider ⇒ null (no throw)", async () => {
    const r = createGitResolver({
      provider: async () => {
        throw new Error("boom")
      },
    })
    expect(await r("status")).toBeNull()
  })
})

// ── C. composite dispatch ────────────────────────────────────────────────
describe("§10.3 composite dispatch", () => {
  test("C1 — folder + git mentions resolve through the composite port", async () => {
    const port = createCompositeMentionResolver({
      folders: { root },
      git: { provider: async (s) => `git-${s}` },
    })
    const frags = await buildInjectionFragments(
      [mention("folder", "src"), mention("git", "status")],
      port,
    )
    expect(frags.map((f) => f.kind)).toEqual(["folder", "git"])
    expect(frags[1]?.bodyText).toBe("git-status")
  })

  test("C2 — folder mention with NO folders dep ⇒ skipped (null)", async () => {
    const port = createCompositeMentionResolver({})
    const frags = await buildInjectionFragments([mention("folder", "src")], port)
    expect(frags).toEqual([])
  })

  test("C3 — git mention with NO git dep ⇒ skipped (null)", async () => {
    const port = createCompositeMentionResolver({})
    const frags = await buildInjectionFragments([mention("git", "status")], port)
    expect(frags).toEqual([])
  })

  test("C4 — hard kind dispatch: a folder mention never hits resolveGit", async () => {
    let gitCalls = 0
    const port = createCompositeMentionResolver({
      folders: { root },
      git: {
        provider: async () => {
          gitCalls++
          return "x"
        },
      },
    })
    await buildInjectionFragments([mention("folder", "src")], port)
    expect(gitCalls).toBe(0)
  })
})

// ── D. byte-identity (default-OFF shape) ─────────────────────────────────
describe("§10.3 byte-identity — omitting folder/git keeps legacy port shape", () => {
  test("D1 — composite without folders/git has no resolveFolder/resolveGit keys", () => {
    const port = createCompositeMentionResolver({})
    expect("resolveFolder" in port).toBe(false)
    expect("resolveGit" in port).toBe(false)
  })

  test("D2 — legacy 3-kind port still exposes exactly skill/plugin/app", () => {
    const port = createCompositeMentionResolver({})
    expect(typeof port.resolveSkill).toBe("function")
    expect(typeof port.resolvePlugin).toBe("function")
    expect(typeof port.resolveApp).toBe("function")
    expect(port.resolveFile).toBeUndefined()
    expect(port.resolveSymbol).toBeUndefined()
  })
})
