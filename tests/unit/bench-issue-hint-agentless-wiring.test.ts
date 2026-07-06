/**
 * Bench driver wiring for `QUANTA_BENCH_ISSUE_HINT=agentless`.
 *
 * Invariants:
 *   - `benchOptIns().issueHintMode` tri-state: `off` / `regex` / `agentless`
 *     resolves from the env string with a strict accept-list.
 *   - `prepareIssueHint` honors the resolved mode:
 *       - `off`        ⇒ returns "" (byte-identical sentinel)
 *       - `regex`      ⇒ returns the legacy `composeIssueHint(extractIssueHint(...))`
 *                        string (byte-identical to pre-feature path)
 *       - `agentless`  ⇒ runs the injected localizer; on empty result, falls
 *                        back to regex; on success, returns the Agentless
 *                        markdown block
 *   - When the localizer LLM is slow/hangs, the 30s default timeout triggers
 *     and the wiring falls back to regex.
 *   - `enumerateRepoSources` walks a real fs sandbox, excludes tests/build/git,
 *     keeps source extensions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentlessLocalizeResult, composeAgentlessHint } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  benchOptIns,
  enumerateRepoSources,
  prepareIssueHint,
} from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

const ENV_KEYS = ["QUANTA_BENCH_ISSUE_HINT"] as const

const snapshot = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}
const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = snapshot()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  restore(saved)
})

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const mkInstance = (problemStatement: string): Instance => ({
  id: "test",
  repoPath: "/tmp/x",
  problemStatement,
  testCmd: "true",
})

describe("benchOptIns — tri-state issueHintMode", () => {
  test("unset → off", () => {
    expect(benchOptIns().issueHintMode).toBe("off")
    expect(benchOptIns().issueHint).toBe(false)
  })

  test("'1' → regex (legacy compat)", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "1"
    expect(benchOptIns().issueHintMode).toBe("regex")
    expect(benchOptIns().issueHint).toBe(true)
  })

  test("'on' → regex", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "on"
    expect(benchOptIns().issueHintMode).toBe("regex")
    expect(benchOptIns().issueHint).toBe(true)
  })

  test("'agentless' → agentless", () => {
    process.env.QUANTA_BENCH_ISSUE_HINT = "agentless"
    expect(benchOptIns().issueHintMode).toBe("agentless")
    // back-compat boolean stays true (anything that produces a hint)
    expect(benchOptIns().issueHint).toBe(true)
  })

  test("misspelled values → off (strict accept-list)", () => {
    for (const v of ["Agentless", "AGENTLESS", "agent-less", "agentless ", " agentless"]) {
      process.env.QUANTA_BENCH_ISSUE_HINT = v
      expect(benchOptIns().issueHintMode).toBe("off")
    }
  })
})

describe("prepareIssueHint — async hint computation", () => {
  test("mode=off → empty string (byte-identical sentinel)", async () => {
    const hint = await prepareIssueHint(
      mkInstance("issue body with requests/models.py"),
      "/tmp/sb",
      "off",
      { llm: new StubLLM(), issueHintExpectedActual: false },
    )
    expect(hint).toBe("")
  })

  test("mode=regex → legacy composeIssueHint output", async () => {
    const hint = await prepareIssueHint(
      mkInstance("See requests/models.py for the bug. UnicodeError"),
      "/tmp/sb",
      "regex",
      { llm: new StubLLM(), issueHintExpectedActual: false },
    )
    expect(hint).toContain("## Issue evidence (verbatim)")
    expect(hint).toContain("requests/models.py")
    expect(hint).toContain("UnicodeError")
  })

  test("mode=regex + empty extraction → ''", async () => {
    const hint = await prepareIssueHint(mkInstance("please make it work"), "/tmp/sb", "regex", {
      llm: new StubLLM(),
      issueHintExpectedActual: false,
    })
    expect(hint).toBe("")
  })

  test("mode=agentless + LLM happy path → Agentless markdown block", async () => {
    const fakeLocalize = async (): Promise<AgentlessLocalizeResult> => ({
      files: ["requests/models.py", "requests/adapters.py"],
      rationales: ["IDNAError handling", "HTTPAdapter URL prep"],
      rawResponse: "raw",
    })
    const hint = await prepareIssueHint(
      mkInstance("UnicodeError on http://.example.com"),
      "/tmp/sb",
      "agentless",
      {
        llm: new StubLLM(),
        issueHintExpectedActual: false,
        fileTree: async () => ["requests/models.py", "requests/adapters.py"],
        localize: fakeLocalize,
        lspPrefetch: false, // unit test: render kernel ON, but no real language server
      },
    )
    // jul-6 S3: default-ON ⇒ observation-kernel render (`<quanta_observations>`,
    // routing-hint framing + anti_signals). The owners/evidence still surface.
    expect(hint).toContain("<quanta_observations>")
    expect(hint).toContain("routing hints — verify against source")
    expect(hint).toContain("requests/models.py")
    expect(hint).toContain("IDNAError handling")
    expect(hint).toContain("anti_signals")
    // OFF (renderObservations:false) ⇒ byte-identical legacy Agentless markdown.
    const legacy = await prepareIssueHint(
      mkInstance("UnicodeError on http://.example.com"),
      "/tmp/sb",
      "agentless",
      {
        llm: new StubLLM(),
        issueHintExpectedActual: false,
        fileTree: async () => ["requests/models.py", "requests/adapters.py"],
        localize: fakeLocalize,
        renderObservations: false,
      },
    )
    expect(legacy).toContain("## Issue Hints (Agentless localization)")
    expect(legacy).toContain("Use these as starting points but verify with your own tools.")
  })

  test("mode=agentless + empty result → falls back to regex", async () => {
    const fakeLocalize = async (): Promise<AgentlessLocalizeResult> => ({
      files: [],
      rationales: [],
      rawResponse: "",
    })
    const hint = await prepareIssueHint(
      mkInstance("See requests/models.py for the bug. UnicodeError"),
      "/tmp/sb",
      "agentless",
      {
        llm: new StubLLM(),
        issueHintExpectedActual: false,
        fileTree: async () => ["requests/models.py"],
        localize: fakeLocalize,
      },
    )
    // Regex fallback kicked in.
    expect(hint).toContain("## Issue evidence (verbatim)")
    expect(hint).toContain("requests/models.py")
  })

  test("mode=agentless + empty result resolves regex file hints back onto repo candidates", async () => {
    const seen: string[][] = []
    const fakeLocalize = async (): Promise<AgentlessLocalizeResult> => ({
      files: [],
      rationales: [],
      rawResponse: "",
    })
    const hint = await prepareIssueHint(
      mkInstance("See 1.11.x/django/db/backends/mysql/operations.py for the timezone bug."),
      "/tmp/sb",
      "agentless",
      {
        llm: new StubLLM(),
        issueHintExpectedActual: false,
        fileTree: async () => [
          "django/db/backends/mysql/operations.py",
          "django/db/backends/sqlite3/operations.py",
        ],
        localize: fakeLocalize,
        onCandidates: (files) => {
          seen.push([...files])
        },
      },
    )
    expect(hint).toContain("1.11.x/django/db/backends/mysql/operations.py")
    expect(seen).toEqual([["django/db/backends/mysql/operations.py"]])
  })

  test("mode=agentless + localizer throws → regex fallback (no crash)", async () => {
    const fakeLocalize = async (): Promise<AgentlessLocalizeResult> => {
      throw new Error("localizer crashed")
    }
    const hint = await prepareIssueHint(
      mkInstance("See requests/models.py UnicodeError"),
      "/tmp/sb",
      "agentless",
      {
        llm: new StubLLM(),
        issueHintExpectedActual: false,
        fileTree: async () => ["requests/models.py"],
        localize: fakeLocalize,
      },
    )
    expect(hint).toContain("## Issue evidence (verbatim)")
  })

  test("mode=agentless + timeout → regex fallback", async () => {
    const slowLocalize = (): Promise<AgentlessLocalizeResult> =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ files: ["x.py"], rationales: ["never"], rawResponse: "raw" }),
          200,
        ),
      )
    const hint = await prepareIssueHint(
      mkInstance("See requests/models.py UnicodeError"),
      "/tmp/sb",
      "agentless",
      {
        llm: new StubLLM(),
        issueHintExpectedActual: false,
        fileTree: async () => ["requests/models.py"],
        localize: slowLocalize,
        timeoutMs: 20, // trip well before slowLocalize resolves
      },
    )
    expect(hint).toContain("## Issue evidence (verbatim)")
    expect(hint).not.toContain("Agentless localization")
  })

  test("mode=agentless + empty problem statement → '' (regex fallback also yields '')", async () => {
    const fakeLocalize = async (): Promise<AgentlessLocalizeResult> => ({
      files: ["x.py"],
      rationales: ["r"],
      rawResponse: "raw",
    })
    const hint = await prepareIssueHint(mkInstance(""), "/tmp/sb", "agentless", {
      llm: new StubLLM(),
      issueHintExpectedActual: false,
      fileTree: async () => ["x.py"],
      localize: fakeLocalize,
    })
    expect(hint).toBe("")
  })
})

describe("enumerateRepoSources — fs walker", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentless-test-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("walks .py files, skips tests/ and .git/", () => {
    // Layout:
    //   src/a.py
    //   src/inner/b.py
    //   tests/test_a.py       ← EXCLUDED (in tests/)
    //   test/test_b.py        ← EXCLUDED (in test/)
    //   .git/config           ← EXCLUDED (in .git/)
    //   node_modules/x.py     ← EXCLUDED
    //   README.md             ← EXCLUDED (wrong extension)
    //   src/c.txt             ← EXCLUDED (wrong extension)
    mkdirSync(join(dir, "src", "inner"), { recursive: true })
    mkdirSync(join(dir, "tests"), { recursive: true })
    mkdirSync(join(dir, "test"), { recursive: true })
    mkdirSync(join(dir, ".git"), { recursive: true })
    mkdirSync(join(dir, "node_modules"), { recursive: true })
    writeFileSync(join(dir, "src", "a.py"), "")
    writeFileSync(join(dir, "src", "inner", "b.py"), "")
    writeFileSync(join(dir, "tests", "test_a.py"), "")
    writeFileSync(join(dir, "test", "test_b.py"), "")
    writeFileSync(join(dir, ".git", "config"), "")
    writeFileSync(join(dir, "node_modules", "x.py"), "")
    writeFileSync(join(dir, "README.md"), "")
    writeFileSync(join(dir, "src", "c.txt"), "")

    const got = enumerateRepoSources(dir)
    expect(got.sort()).toEqual(["src/a.py", "src/inner/b.py"])
  })

  test("returns [] for non-existent repo (silent)", () => {
    const got = enumerateRepoSources(join(dir, "does-not-exist"))
    expect(got).toEqual([])
  })

  test("returns [] for empty dir", () => {
    const got = enumerateRepoSources(dir)
    expect(got).toEqual([])
  })

  test("multi-extension repo (py + ts + go)", () => {
    writeFileSync(join(dir, "main.py"), "")
    writeFileSync(join(dir, "main.ts"), "")
    writeFileSync(join(dir, "main.go"), "")
    writeFileSync(join(dir, "main.exe"), "") // not in source extensions
    const got = enumerateRepoSources(dir).sort()
    expect(got).toEqual(["main.go", "main.py", "main.ts"])
  })
})

describe("3-path byte-identity proof", () => {
  // Same instance, run prepareIssueHint under all three modes. Pre-feature
  // (mode=off) and legacy (mode=regex) MUST agree with the pre-async path.
  const issue = "See requests/models.py UnicodeError"

  test("off mode → ''", async () => {
    const hint = await prepareIssueHint(mkInstance(issue), "/tmp/sb", "off", {
      llm: new StubLLM(),
      issueHintExpectedActual: false,
    })
    expect(hint).toBe("")
  })

  test("G3 hellgate: renderObservations=false ⇒ EXACTLY composeAgentlessHint (no LSP-owner leak)", async () => {
    // The kernel-OFF path must reproduce the pre-feature agentless hint BYTE-FOR-BYTE,
    // even though lspPrefetch defaults ON — LSP-enrich is gated on render being on, so
    // it can never leak symbol-owners into the legacy render. RED before that gate fix.
    const result: AgentlessLocalizeResult = {
      files: ["requests/models.py", "requests/utils.py"],
      rationales: ["prepare_url", "idna helper"],
      rawResponse: "raw",
    }
    const hint = await prepareIssueHint(mkInstance(issue), "/tmp/sb", "agentless", {
      llm: new StubLLM(),
      issueHintExpectedActual: false,
      fileTree: async () => result.files,
      localize: async () => result,
      renderObservations: false,
      // lspPrefetch intentionally UNSET (defaults on) — must still be byte-identical.
    })
    expect(hint).toBe(composeAgentlessHint(result))
  })

  test("regex mode → composeIssueHint output (legacy parity)", async () => {
    const hint = await prepareIssueHint(mkInstance(issue), "/tmp/sb", "regex", {
      llm: new StubLLM(),
      issueHintExpectedActual: false,
    })
    // Re-derive the legacy output to verify byte-identity.
    const { composeIssueHint, extractIssueHint } = await import("@/agent")
    expect(hint).toBe(composeIssueHint(extractIssueHint(issue)))
  })

  test("agentless mode (LLM happy path) → distinct Agentless markdown", async () => {
    const fakeLocalize = async (): Promise<AgentlessLocalizeResult> => ({
      files: ["requests/models.py"],
      rationales: ["IDNA"],
      rawResponse: "raw",
    })
    const hint = await prepareIssueHint(mkInstance(issue), "/tmp/sb", "agentless", {
      llm: new StubLLM(),
      issueHintExpectedActual: false,
      fileTree: async () => ["requests/models.py"],
      localize: fakeLocalize,
    })
    // jul-6 S3 default-ON: agentless path now renders the observation kernel —
    // still DISTINCT from the regex path (which carries "Issue evidence (verbatim)").
    expect(hint).toContain("<quanta_observations>")
    expect(hint).not.toContain("Issue evidence (verbatim)")
  })

  test("caller posture owns expected/actual extraction (no ambient env reread)", async () => {
    const issue = ["Expected: returns 1", "Actual: returns 0", "See foo.py"].join("\n")
    const hint = await prepareIssueHint(mkInstance(issue), "/tmp/sb", "regex", {
      llm: new StubLLM(),
      issueHintExpectedActual: true,
    })
    expect(hint).toContain("Expected:")
    expect(hint).toContain("Actual:")
  })
})
