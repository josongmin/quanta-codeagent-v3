import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { defSiteOf, resolveOwnerSiblings } from "@/agent/closure"

// django-14315 shape: base + postgresql (and other backends) define the SAME
// method. Localizing the parent must surface the sibling override sites.
const BASE = "django/db/backends/base/client.py"
const PG = "django/db/backends/postgresql/client.py"
const MYSQL = "django/db/backends/mysql/client.py"

const baseSource = [
  "class BaseDatabaseClient:",
  "    def settings_to_cmd_args_env(cls, settings_dict, parameters):",
  "        raise NotImplementedError",
  "    def runshell(self, parameters):",
  "        pass",
].join("\n")

// `listDefiners` stub: maps a symbol → files that define it (what ripgrep returns).
const stubDefiners =
  (map: Record<string, string[]>) =>
  (symbol: string): string[] =>
    map[symbol] ?? []

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

describe("resolveOwnerSiblings (WS2 grep-based feeder)", () => {
  test("localizing the owner surfaces OTHER files defining the same symbol", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: "/repo",
      readSource: (f) => (f === BASE ? baseSource : null),
      listDefiners: stubDefiners({ settings_to_cmd_args_env: [BASE, PG, MYSQL] }),
    })
    // BASE excluded (it's the owner / already localized); PG + MYSQL are siblings.
    expect(out).toEqual([
      { file: PG, forSymbol: "settings_to_cmd_args_env" },
      { file: MYSQL, forSymbol: "settings_to_cmd_args_env" },
    ])
  })

  test("owner-gated: a file that only MENTIONS the symbol (no def) expands nothing", async () => {
    // base source defines settings_to_cmd_args_env but NOT `save`; even if the
    // definer map has `save` hits, the owner doesn't own it ⇒ no expansion.
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["save"],
      cwd: "/repo",
      readSource: () => baseSource,
      listDefiners: stubDefiners({ save: ["models/base.py", "forms/models.py"] }),
    })
    expect(out).toEqual([])
  })

  test("self + already-localized files are excluded from siblings", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [
        { file: BASE, score: 5 },
        { file: PG, score: 4 },
      ],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: "/repo",
      readSource: () => baseSource,
      listDefiners: stubDefiners({ settings_to_cmd_args_env: [BASE, PG, MYSQL] }),
    })
    // BASE + PG are both in stage1 (localized) ⇒ only MYSQL remains a sibling.
    expect(out).toEqual([{ file: MYSQL, forSymbol: "settings_to_cmd_args_env" }])
  })

  test("dedup + bounded by maxResults", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: "/repo",
      readSource: () => baseSource,
      listDefiners: stubDefiners({ settings_to_cmd_args_env: ["a.py", "a.py", "b.py", "c.py"] }),
      maxResults: 2,
    })
    expect(out.length).toBe(2)
    expect(new Set(out.map((o) => o.file)).size).toBe(2)
  })

  test("missing source skips the file (no crash)", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: BASE, score: 5 }],
      issueSymbols: ["settings_to_cmd_args_env"],
      cwd: "/repo",
      readSource: () => null,
      listDefiners: stubDefiners({ settings_to_cmd_args_env: [BASE, PG] }),
    })
    expect(out).toEqual([])
  })

  test("maxFiles bounds how many stage-1 owners are probed", async () => {
    const probed: string[] = []
    await resolveOwnerSiblings()({
      stage1Files: [
        { file: "a.py", score: 4 },
        { file: "b.py", score: 3 },
        { file: "c.py", score: 2 },
      ],
      issueSymbols: ["x"],
      cwd: "/repo",
      readSource: (f) => {
        probed.push(f)
        return "def x():\n    pass"
      },
      listDefiners: stubDefiners({ x: ["a.py", "b.py", "c.py", "z.py"] }),
      maxFiles: 2,
    })
    expect(probed).toEqual(["a.py", "b.py"])
  })

  // Integration: the DEFAULT path (no listDefiners) runs real ripgrep over a tmp
  // working tree — proves the grep pivot works end-to-end (the LSP path returned
  // [] on real pyright; this is why we pivoted).
  test("ripgrep default finds the sibling on a real tree (integration)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws2-rg-"))
    try {
      writeFileSync(join(dir, "a.py"), "class A:\n    def settings_to_cmd_args_env(self):\n        pass\n")
      writeFileSync(join(dir, "b.py"), "class B:\n    def settings_to_cmd_args_env(self):\n        pass\n")
      const out = await resolveOwnerSiblings()({
        stage1Files: [{ file: "a.py", score: 5 }],
        issueSymbols: ["settings_to_cmd_args_env"],
        cwd: dir,
        readSource: (rel) => readFileSync(join(dir, rel), "utf8"),
      })
      expect(out).toEqual([{ file: "b.py", forSymbol: "settings_to_cmd_args_env" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
