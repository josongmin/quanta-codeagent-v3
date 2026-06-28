import { describe, expect, test } from "bun:test"
import {
  buildLexicalReproGroundingPorts,
  type ReproGroundingPorts,
  retrieveExemplarSkeletons,
} from "./repro-grounding"

const RAW_TEST = `import pytest
from pkg.testing import Harness

@pytest.mark.harness("html")
def test_thing(app: Harness):
    app.build()
    assert app.result == "SECRET-GOLD"
`

const portsWith = (over: Partial<ReproGroundingPorts>): ReproGroundingPorts => ({
  relatedTests: async () => [],
  ...over,
})

describe("retrieveExemplarSkeletons — gated orchestrator (C4)", () => {
  test("enabled=false ⇒ {} and NO port call (byte-identical / inert)", async () => {
    let called = false
    const out = await retrieveExemplarSkeletons({
      enabled: false,
      sourceFiles: ["pkg/foo.py"],
      ports: portsWith({
        relatedTests: async () => {
          called = true
          return [{ path: "t.py", text: RAW_TEST }]
        },
      }),
    })
    expect(out).toEqual({})
    expect(called).toBe(false)
  })

  test("empty sourceFiles ⇒ no exemplar retrieval", async () => {
    let called = false
    const out = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: [],
      ports: portsWith({
        relatedTests: async () => {
          called = true
          return [{ path: "t.py", text: RAW_TEST }]
        },
      }),
    })
    expect(out).toEqual({})
    expect(called).toBe(false)
  })

  test("on ⇒ strips bodies (NO-LEAK) and keeps the fixture pattern", async () => {
    const out = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: ["pkg/foo.py"],
      ports: portsWith({ relatedTests: async () => [{ path: "t.py", text: RAW_TEST }] }),
    })
    const sk = (out.exemplarSkeletons ?? []).join("\n")
    expect(out.exemplarSkeletons).toHaveLength(1)
    expect(sk).toContain("from pkg.testing import Harness")
    expect(sk).toContain('@pytest.mark.harness("html")')
    expect(sk).not.toContain("SECRET-GOLD")
    expect(sk).not.toMatch(/\bassert\b/)
  })

  test("respects maxExemplars bound", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      path: `t${i}.py`,
      text: `import os\ndef test_${i}():\n    assert os.path`,
    }))
    const out = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: ["pkg/foo.py"],
      maxExemplars: 2,
      ports: portsWith({ relatedTests: async () => many }),
    })
    expect(out.exemplarSkeletons).toHaveLength(2)
  })

  test("skips empty-after-strip skeletons", async () => {
    const out = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: ["pkg/foo.py"],
      ports: portsWith({
        relatedTests: async () => [
          { path: "blank.py", text: "x = 1\ny = 2\n" }, // no structural lines ⇒ ""
          { path: "real.py", text: "import os\ndef test_a():\n    assert os" },
        ],
      }),
    })
    expect(out.exemplarSkeletons).toHaveLength(1)
    expect(out.exemplarSkeletons?.[0]).toContain("import os")
  })

  test("signatures port is consulted only with symbols; degrades on throw", async () => {
    const ok = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: [],
      issueSymbols: ["Foo.bar"],
      ports: portsWith({ signatures: async () => ["def bar(self) -> int: ..."] }),
    })
    expect(ok.issueSignatures).toEqual(["def bar(self) -> int: ..."])

    const noSymbols = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: [],
      ports: portsWith({ signatures: async () => ["should-not-appear"] }),
    })
    expect(noSymbols).toEqual({})

    const thrown = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: [],
      issueSymbols: ["Foo.bar"],
      ports: portsWith({
        signatures: async () => {
          throw new Error("lsp down")
        },
      }),
    })
    expect(thrown).toEqual({}) // degrade, not throw
  })

  test("relatedTests rejection degrades to {} (a flaky retrieval never fails repro-gen)", async () => {
    const out = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: ["pkg/foo.py"],
      ports: portsWith({
        relatedTests: async () => {
          throw new Error("git ls-files failed")
        },
      }),
    })
    expect(out).toEqual({})
  })
})

describe("buildLexicalReproGroundingPorts — ranks + maps text", () => {
  test("lists → reads → discovers → returns ranked {path,text}", async () => {
    const ports = buildLexicalReproGroundingPorts({
      sandbox: "/repo",
      timeoutMs: 1000,
      listFiles: async () => ["tests/test_a.py", "tests/test_b.py", "pkg/foo.py"],
      readTests: async (_sb, paths) =>
        paths
          .filter((p) => p.includes("test_"))
          .map((p) => ({ path: p, text: `import pkg.foo\ndef ${p}():\n    assert 1` })),
      discover: () => ["tests/test_b.py", "tests/test_a.py"], // ranked order
    })
    const related = await ports.relatedTests(["pkg/foo.py"])
    expect(related.map((r) => r.path)).toEqual(["tests/test_b.py", "tests/test_a.py"])
    expect(related[0]?.text).toContain("import pkg.foo")
  })

  test("empty sourceFiles ⇒ [] (no work)", async () => {
    let listed = false
    const ports = buildLexicalReproGroundingPorts({
      sandbox: "/repo",
      timeoutMs: 1000,
      listFiles: async () => {
        listed = true
        return []
      },
    })
    expect(await ports.relatedTests([])).toEqual([])
    expect(listed).toBe(false)
  })

  test("end-to-end through the orchestrator strips lexical-adapter bodies", async () => {
    const ports = buildLexicalReproGroundingPorts({
      sandbox: "/repo",
      timeoutMs: 1000,
      listFiles: async () => ["tests/test_a.py"],
      readTests: async (_sb, paths) => paths.map((p) => ({ path: p, text: RAW_TEST })),
      discover: () => ["tests/test_a.py"],
    })
    const out = await retrieveExemplarSkeletons({
      enabled: true,
      sourceFiles: ["pkg/foo.py"],
      ports,
    })
    expect(out.exemplarSkeletons?.[0]).not.toContain("SECRET-GOLD")
    expect(out.exemplarSkeletons?.[0]).toContain("from pkg.testing import Harness")
  })
})
