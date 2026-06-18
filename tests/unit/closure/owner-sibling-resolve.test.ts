import { describe, expect, test } from "bun:test"
import { defSiteOf, resolveOwnerSiblings } from "@/agent/closure"
import type { LspNavProvider } from "@/tool"

// django-14315 shape: parent base + child postgresql override the SAME method.
const BASE = "django/db/backends/base/client.py"
const PG = "django/db/backends/postgresql/client.py"
const CWD = "/repo"

const baseSource = [
  "class BaseDatabaseClient:",
  "    def settings_to_cmd_args_env(cls, settings_dict, parameters):",
  "        return args, env",
  "    def runshell(self, parameters):",
  "        pass",
].join("\n")

const pgSource = [
  "class DatabaseClient(BaseDatabaseClient):",
  "    def settings_to_cmd_args_env(cls, settings_dict, parameters):",
  "        return args, env",
].join("\n")

const loc = (rel: string): { uri: string; range: { start: { line: number; character: number } } } => ({
  uri: `file://${CWD}/${rel}`,
  range: { start: { line: 0, character: 0 } },
})

// Minimal stub provider: only `open` is exercised by the resolver; the returned
// session answers implementation/definition from the supplied maps.
const stubProvider = (opts: {
  impl?: Record<string, ReturnType<typeof loc>[]>
  def?: Record<string, ReturnType<typeof loc>[]>
}): LspNavProvider =>
  ({
    open: async () => ({
      // biome-ignore lint/suspicious/useAwait: stub
      implementation: async (f: string) => opts.impl?.[f] ?? null,
      // biome-ignore lint/suspicious/useAwait: stub
      definition: async (f: string) => opts.def?.[f] ?? null,
      references: async () => null,
      hover: async () => null,
      stop: async () => undefined,
    }),
  }) as unknown as LspNavProvider

describe("defSiteOf", () => {
  test("matches def / async def / class; returns the symbol column", () => {
    expect(defSiteOf("class Foo:\n    def bar(self):\n        pass", "bar")).toEqual({
      line: 1,
      character: 8,
    })
    expect(defSiteOf("async def baz():\n    pass", "baz")).toEqual({ line: 0, character: 10 })
    expect(defSiteOf("class Widget:\n    pass", "Widget")).toEqual({ line: 0, character: 6 })
  })

  test("null when the symbol is not DEFINED here (a bare reference doesn't count)", () => {
    expect(defSiteOf("x = settings_to_cmd_args_env()", "settings_to_cmd_args_env")).toBeNull()
    expect(defSiteOf("# nothing", "bar")).toBeNull()
  })
})

describe("resolveOwnerSiblings (WS2 feeder)", () => {
  test("child override surfaced as sibling when parent is localized (implementation)", async () => {
    const provider = stubProvider({ impl: { [BASE]: [loc(PG)] } })
    const out = await resolveOwnerSiblings(provider)({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: CWD,
      readSource: (f) => (f === BASE ? baseSource : null),
    })
    expect(out).toEqual([{ file: PG, forSymbol: "settings_to_cmd_args_env" }])
  })

  test("parent surfaced when child is localized (definition)", async () => {
    const provider = stubProvider({ def: { [PG]: [loc(BASE)] } })
    const out = await resolveOwnerSiblings(provider)({
      stage1Files: [{ file: PG, score: 5 }],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: CWD,
      readSource: (f) => (f === PG ? pgSource : null),
    })
    expect(out).toEqual([{ file: BASE, forSymbol: "settings_to_cmd_args_env" }])
  })

  test("self-hit excluded — the originating file is never its own sibling", async () => {
    const provider = stubProvider({ def: { [BASE]: [loc(BASE)] }, impl: { [BASE]: [loc(BASE)] } })
    const out = await resolveOwnerSiblings(provider)({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: CWD,
      readSource: () => baseSource,
    })
    expect(out).toEqual([])
  })

  test("dedup across symbols + bounded by maxResults", async () => {
    const provider = stubProvider({
      impl: { [BASE]: [loc("a.py"), loc("a.py"), loc("b.py"), loc("c.py")] },
    })
    const out = await resolveOwnerSiblings(provider)({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: CWD,
      readSource: () => baseSource,
      maxResults: 2,
    })
    expect(out.length).toBe(2)
    expect(new Set(out.map((o) => o.file)).size).toBe(2) // a.py deduped
  })

  test("blind: a symbol not defined in the file yields nothing (no LSP call wasted)", async () => {
    let opened = 0
    const provider = {
      open: async () => {
        opened++
        return {
          implementation: async () => [loc(PG)],
          definition: async () => null,
          references: async () => null,
          hover: async () => null,
          stop: async () => undefined,
        }
      },
    } as unknown as LspNavProvider
    const out = await resolveOwnerSiblings(provider)({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["nonexistent_symbol"],
      cwd: CWD,
      readSource: () => baseSource,
    })
    expect(out).toEqual([])
    // session opened, but no implementation() because defSiteOf returned null
    expect(opened).toBe(1)
  })

  test("missing source skips the file (no crash, no resolve)", async () => {
    const provider = stubProvider({ impl: { [BASE]: [loc(PG)] } })
    const out = await resolveOwnerSiblings(provider)({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: CWD,
      readSource: () => null,
    })
    expect(out).toEqual([])
  })

  test("maxFiles bounds how many stage-1 candidates are probed", async () => {
    const opened: string[] = []
    const provider = {
      open: async (f: string) => {
        opened.push(f)
        return {
          implementation: async () => null,
          definition: async () => null,
          references: async () => null,
          hover: async () => null,
          stop: async () => undefined,
        }
      },
    } as unknown as LspNavProvider
    await resolveOwnerSiblings(provider)({
      stage1Files: [
        { file: "a.py", score: 3 },
        { file: "b.py", score: 2 },
        { file: "c.py", score: 1 },
        { file: "d.py", score: 0 },
      ],
      issueSymbols: ["x"],
      cwd: CWD,
      readSource: () => "def x():\n    pass",
      maxFiles: 2,
    })
    expect(opened).toEqual(["a.py", "b.py"])
  })
})
