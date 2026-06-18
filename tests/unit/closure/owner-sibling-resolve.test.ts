import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { defsInSource, resolveOwnerSiblings } from "@/agent/closure"

// django-14315 shape: base + postgresql (+ other backends) define the SAME
// methods. The issue mentions `runshell` in PROSE (extractSymbols, backtick-only,
// returns []). Anchoring on owner-def ∩ issue-mention recovers it.
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

const stubDefiners =
  (map: Record<string, string[]>) =>
  (symbol: string): string[] =>
    map[symbol] ?? []

describe("defsInSource", () => {
  test("extracts def / async def / class names; excludes dunder", () => {
    const src = "class Foo:\n    def bar(self):\n        pass\n    def __init__(self):\n        pass\nasync def baz():\n    pass"
    expect(defsInSource(src).sort()).toEqual(["Foo", "bar", "baz"])
  })

  test("empty when nothing is defined", () => {
    expect(defsInSource("x = 1\n# comment")).toEqual([])
  })
})

describe("resolveOwnerSiblings (WS2 grep + issueText anchor)", () => {
  test("anchor = owner-def ∩ issue-mention ⇒ siblings via the mentioned method", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: BASE, score: 5 }],
      // mentions `runshell` (prose) but NOT settings_to_cmd_args_env
      issueText: "database client runshell doesn't respect os.environ values",
      cwd: "/repo",
      readSource: (f) => (f === BASE ? baseSource : null),
      listDefiners: stubDefiners({
        runshell: [BASE, PG, MYSQL],
        settings_to_cmd_args_env: [BASE, PG],
      }),
    })
    // runshell is the only anchor (defined in base + mentioned) ⇒ PG + MYSQL.
    // settings_to_cmd_args_env is defined in base but NOT mentioned ⇒ not an anchor.
    expect(out).toEqual([
      { file: PG, forSymbol: "runshell" },
      { file: MYSQL, forSymbol: "runshell" },
    ])
  })

  test("word-boundary mention: `env` in the issue does NOT match `environ`", async () => {
    const src = "class C:\n    def env(self):\n        pass"
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: "a.py", score: 5 }],
      issueText: "os.environ is not respected", // contains 'environ', not the word 'env'
      cwd: "/repo",
      readSource: () => src,
      listDefiners: stubDefiners({ env: ["a.py", "b.py"] }),
    })
    expect(out).toEqual([])
  })

  test("owner-gated: an issue-mentioned symbol the owner does NOT define expands nothing", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: BASE, score: 5 }],
      issueText: "the save method is broken", // base doesn't define `save`
      cwd: "/repo",
      readSource: () => baseSource,
      listDefiners: stubDefiners({ save: ["models/base.py"] }),
    })
    expect(out).toEqual([])
  })

  test("self + already-localized files are excluded", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [
        { file: BASE, score: 5 },
        { file: PG, score: 4 },
      ],
      issueText: "runshell is broken",
      cwd: "/repo",
      readSource: () => baseSource,
      listDefiners: stubDefiners({ runshell: [BASE, PG, MYSQL] }),
    })
    expect(out).toEqual([{ file: MYSQL, forSymbol: "runshell" }])
  })

  test("dedup + bounded by maxResults", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: BASE, score: 5 }],
      issueText: "runshell",
      cwd: "/repo",
      readSource: () => baseSource,
      listDefiners: stubDefiners({ runshell: ["a.py", "a.py", "b.py", "c.py"] }),
      maxResults: 2,
    })
    expect(out.length).toBe(2)
    expect(new Set(out.map((o) => o.file)).size).toBe(2)
  })

  test("missing source skips the file (no crash)", async () => {
    const out = await resolveOwnerSiblings()({
      stage1Files: [{ file: BASE, score: 5 }],
      issueText: "runshell",
      cwd: "/repo",
      readSource: () => null,
      listDefiners: stubDefiners({ runshell: [BASE, PG] }),
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
      issueText: "foo is broken",
      cwd: "/repo",
      readSource: (f) => {
        probed.push(f)
        return "def foo():\n    pass"
      },
      listDefiners: stubDefiners({ foo: ["a.py", "b.py", "c.py", "z.py"] }),
      maxFiles: 2,
    })
    expect(probed).toEqual(["a.py", "b.py"])
  })

  // Integration: DEFAULT path (real ripgrep) over a tmp tree — the grep pivot
  // that replaced the inert LSP path, end-to-end.
  test("ripgrep default finds the sibling on a real tree (integration)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ws2-rg-"))
    try {
      writeFileSync(join(dir, "a.py"), "class A:\n    def settings_to_cmd_args_env(self):\n        pass\n")
      writeFileSync(join(dir, "b.py"), "class B:\n    def settings_to_cmd_args_env(self):\n        pass\n")
      const out = await resolveOwnerSiblings()({
        stage1Files: [{ file: "a.py", score: 5 }],
        issueText: "the settings_to_cmd_args_env method returns the wrong value",
        cwd: dir,
        readSource: (rel) => readFileSync(join(dir, rel), "utf8"),
      })
      expect(out).toEqual([{ file: "b.py", forSymbol: "settings_to_cmd_args_env" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
