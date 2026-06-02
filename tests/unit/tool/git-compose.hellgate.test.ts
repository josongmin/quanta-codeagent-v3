/** Hellgate battery for `git_compose_commit` + `git_compose_pr` — diff→prose
 *  AUTHORING (Codex `yeet` / Cursor compose absorption).
 *
 *  Adversarial coverage (per GOAL):
 *    • metadata: name, isReadOnly=true, isConcurrencySafe=true, hitlTier "none"
 *    • empty / no staged diff → typed ok:false (NOT a crash, NOT a commit)
 *    • huge diff → bounded/truncated input handed to the author LLM
 *    • LLM returns garbage / non-conventional prose → still a TYPED result
 *      (conventional:false), never a throw
 *    • LLM returns proper Conventional Commits → parsed type/scope/subject/body
 *    • author message round-trips into git_commit regular mode
 *    • LLM stream throws / empty message → typed ok:false
 *    • absent authorLLM ⇒ tools NOT in registry (byte-identical) — proven via
 *      gitTools() with and without opts.authorLLM
 *    • git_compose_pr: empty range → ok:false; leading-`-` rev rejected;
 *      structured <TITLE>/<BODY> parsed; fallback parse for free text
 *    • diff spawn-error / exit>1 → typed ok:false
 *    • signal forwarded to git runner AND author LLM
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { gitCommitTool } from "@/tool/git/commit"
import {
  buildCommitAuthorPrompt,
  diffToScopes,
  gitComposeCommitTool,
  gitComposePrTool,
  parseConventionalCommit,
  parsePrAuthored,
} from "@/tool/git/compose"
import { gitTools } from "@/tool/git/index"
import type { GitRunner, GitRunResult } from "@/tool/git/types"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

// ── doubles ──────────────────────────────────────────────────────────────

interface RunnerCall {
  args: readonly string[]
  cwd: string
  signal?: AbortSignal
}

/** Fake git runner. `byArgs` matches on the joined argv prefix so a test can
 *  script distinct results for `diff` vs `log`. */
const fakeRunner = (
  responder: (args: readonly string[]) => GitRunResult | Error,
): { runner: GitRunner; calls: RunnerCall[] } => {
  const calls: RunnerCall[] = []
  const runner: GitRunner = {
    async run(args, cwd, signal) {
      calls.push({ args, cwd, ...(signal !== undefined ? { signal } : {}) })
      const out = responder(args)
      if (out instanceof Error) throw out
      return out
    },
  }
  return { runner, calls }
}

const ok = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 0 })
const hasDiff = (stdout: string): GitRunResult => ({ stdout, stderr: "", exitCode: 1 })
const fail = (stderr: string, code = 128): GitRunResult => ({ stdout: "", stderr, exitCode: code })

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Author-LLM double. Records every StreamInput; yields a scripted reply or
 *  throws. */
class FakeAuthor implements LLMPort {
  readonly inputs: StreamInput[] = []
  readonly model = "fake-author"
  constructor(private readonly reply: StreamEvent[] | Error) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    if (this.reply instanceof Error) throw this.reply
    for (const e of this.reply) yield e
  }
}

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/repo",
  signal: signal ?? new AbortController().signal,
})

const drain = async (it: AsyncIterable<ToolEvent>): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const e of it) if (e.type === "result") result = e.result
  if (result === undefined) throw new Error("tool yielded no result")
  return result
}

// ── pure-parser tests ──────────────────────────────────────────────────────

describe("parseConventionalCommit", () => {
  test("parses type(scope): subject + body", () => {
    const p = parseConventionalCommit("feat(parser): add YAML support\n\nWhy: needed for configs.")
    expect(p.conventional).toBe(true)
    expect(p.type).toBe("feat")
    expect(p.scope).toBe("parser")
    expect(p.subject).toBe("add YAML support")
    expect(p.body).toBe("Why: needed for configs.")
  })

  test("parses type without scope", () => {
    const p = parseConventionalCommit("fix: handle empty diff")
    expect(p.conventional).toBe(true)
    expect(p.type).toBe("fix")
    expect(p.scope).toBeUndefined()
    expect(p.subject).toBe("handle empty diff")
    expect(p.body).toBe("")
  })

  test("garbage / non-conventional → conventional:false, raw surfaced", () => {
    const p = parseConventionalCommit("just some random text that is not a commit")
    expect(p.conventional).toBe(false)
    expect(p.subject).toBe("just some random text that is not a commit")
    expect(p.message).toBe("just some random text that is not a commit")
  })

  test("strips an enclosing code fence the LLM may wrap around the message", () => {
    const p = parseConventionalCommit("```\nchore: bump deps\n```")
    expect(p.conventional).toBe(true)
    expect(p.type).toBe("chore")
    expect(p.subject).toBe("bump deps")
  })
})

describe("parsePrAuthored", () => {
  test("parses <TITLE>/<BODY> delimiters", () => {
    const p = parsePrAuthored(
      "<TITLE>\nAdd compose tools\n</TITLE>\n<BODY>\n## Summary\n- x\n</BODY>",
    )
    expect(p.structured).toBe(true)
    expect(p.title).toBe("Add compose tools")
    expect(p.body).toContain("## Summary")
  })

  test("falls back to first-line title + remainder body for free text", () => {
    const p = parsePrAuthored("Add compose tools\n\nThis does the thing.")
    expect(p.structured).toBe(false)
    expect(p.title).toBe("Add compose tools")
    expect(p.body).toBe("This does the thing.")
  })
})

// ── git_compose_commit ──────────────────────────────────────────────────────

describe("git_compose_commit", () => {
  test("metadata: read-only, concurrency-safe, hitlTier none", () => {
    const t = gitComposeCommitTool(fakeRunner(() => ok("")).runner, new FakeAuthor(text("x")))
    expect(t.name).toBe("git_compose_commit")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({})).toBe(true)
    expect(t.hitlTier?.({})).toBe("none")
  })

  test("authors a Conventional Commits message from the staged diff", async () => {
    const { runner, calls } = fakeRunner(() => hasDiff("diff --git a/x b/x\n+added"))
    const author = new FakeAuthor(text("feat(x): add the thing\n\nBecause reasons."))
    const t = gitComposeCommitTool(runner, author)
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(true)
    expect(res.output).toContain("feat(x): add the thing")
    // staged diff was requested
    expect(calls[0]?.args).toEqual(["diff", "--staged"])
    // diff text reached the author
    expect(author.inputs[0]?.messages[0]?.content[0]).toMatchObject({ type: "text" })
    const structured = res.structured as { conventional: boolean; type: string }
    expect(structured.conventional).toBe(true)
    expect(structured.type).toBe("feat")
  })

  test("authored message round-trips into git_commit regular mode", async () => {
    const author = new FakeAuthor(text("fix(loop): stop double-yield"))
    const composeRes = await drain(
      gitComposeCommitTool(fakeRunner(() => hasDiff("d")).runner, author).execute({}, ctx()),
    )
    expect(composeRes.ok).toBe(true)
    const authored = composeRes.output

    // Feed it into git_commit regular mode; assert it lands verbatim in argv.
    const { runner: commitRunner, calls } = fakeRunner(() => ok(""))
    const commitRes = await drain(
      gitCommitTool(commitRunner).execute({ mode: "regular", message: authored }, ctx()),
    )
    expect(commitRes.ok).toBe(true)
    const commitCall = calls.find((c) => c.args[0] === "commit")
    expect(commitCall?.args).toEqual(["commit", "-m", authored])
  })

  test("empty staged diff → typed ok:false, author NOT called, no crash", async () => {
    const author = new FakeAuthor(text("should-not-be-used"))
    const t = gitComposeCommitTool(fakeRunner(() => ok("")).runner, author)
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("nothing staged")
    expect(author.inputs.length).toBe(0)
  })

  test("huge diff → truncated input handed to the author", async () => {
    const huge = `+${"x".repeat(200_000)}`
    const author = new FakeAuthor(text("chore: big change"))
    const t = gitComposeCommitTool(fakeRunner(() => hasDiff(huge)).runner, author)
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(true)
    const sent = author.inputs[0]?.messages[0]?.content[0] as { type: "text"; text: string }
    expect(sent.text).toContain("truncated")
    // bounded: well under the raw 200k
    expect(sent.text.length).toBeLessThan(120_000)
  })

  test("LLM returns non-conventional garbage → still typed ok:true, conventional:false", async () => {
    const author = new FakeAuthor(text("I think this looks good lol"))
    const t = gitComposeCommitTool(fakeRunner(() => hasDiff("d")).runner, author)
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(true)
    expect((res.structured as { conventional: boolean }).conventional).toBe(false)
  })

  test("LLM stream throws → typed ok:false (no throw past the loop)", async () => {
    const author = new FakeAuthor(new Error("provider 500"))
    const t = gitComposeCommitTool(fakeRunner(() => hasDiff("d")).runner, author)
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("author LLM stream failed")
  })

  test("LLM returns empty message → typed ok:false", async () => {
    const author = new FakeAuthor([{ type: "message_stop", stop_reason: "end_turn" }])
    const t = gitComposeCommitTool(fakeRunner(() => hasDiff("d")).runner, author)
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("empty message")
  })

  test("git diff spawn-error → typed ok:false", async () => {
    const t = gitComposeCommitTool(
      fakeRunner(() => new Error("git: command not found")).runner,
      new FakeAuthor(text("x")),
    )
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(false)
  })

  test("git diff exit>1 → typed ok:false", async () => {
    const t = gitComposeCommitTool(
      fakeRunner(() => fail("fatal: not a git repository")).runner,
      new FakeAuthor(text("x")),
    )
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("not a git repository")
  })

  test("paths scope the staged diff (appended after --)", async () => {
    const { runner, calls } = fakeRunner(() => hasDiff("d"))
    const t = gitComposeCommitTool(runner, new FakeAuthor(text("feat: x")))
    await drain(t.execute({ paths: ["src/a.ts", "src/b.ts"] }, ctx()))
    expect(calls[0]?.args).toEqual(["diff", "--staged", "--", "src/a.ts", "src/b.ts"])
  })

  test("signal forwarded to git runner AND author LLM", async () => {
    const signal = new AbortController().signal
    const { runner, calls } = fakeRunner(() => hasDiff("d"))
    const author = new FakeAuthor(text("feat: x"))
    await drain(gitComposeCommitTool(runner, author).execute({}, ctx(signal)))
    expect(calls[0]?.signal).toBe(signal)
    expect(author.inputs[0]?.signal).toBe(signal)
  })
})

// ── git_compose_pr ───────────────────────────────────────────────────────

describe("git_compose_pr", () => {
  test("metadata: read-only, concurrency-safe, hitlTier none", () => {
    const t = gitComposePrTool(fakeRunner(() => ok("")).runner, new FakeAuthor(text("x")))
    expect(t.name).toBe("git_compose_pr")
    expect(t.isReadOnly()).toBe(true)
    expect(t.isConcurrencySafe({})).toBe(true)
    expect(t.hitlTier?.({})).toBe("none")
  })

  test("authors title + body from branch diff + log (default range)", async () => {
    const { runner, calls } = fakeRunner((args) =>
      args[0] === "log" ? ok("abc feat: a\ndef fix: b") : hasDiff("diff --git a/x b/x"),
    )
    const author = new FakeAuthor(
      text("<TITLE>\nAdd compose authoring\n</TITLE>\n<BODY>\n## Summary\n- new tools\n</BODY>"),
    )
    const res = await drain(gitComposePrTool(runner, author).execute({}, ctx()))
    expect(res.ok).toBe(true)
    expect(res.output).toContain("Add compose authoring")
    // default range
    expect(calls[0]?.args).toEqual(["diff", "origin/main...HEAD"])
    // log used base..head (two-dot)
    expect(calls.find((c) => c.args[0] === "log")?.args).toContain("origin/main..HEAD")
    const structured = res.structured as { structured: boolean; title: string }
    expect(structured.structured).toBe(true)
    expect(structured.title).toBe("Add compose authoring")
  })

  test("empty range → typed ok:false, author NOT called", async () => {
    const author = new FakeAuthor(text("nope"))
    const res = await drain(
      gitComposePrTool(fakeRunner(() => ok("")).runner, author).execute({}, ctx()),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("empty")
    expect(author.inputs.length).toBe(0)
  })

  test("leading-'-' base rejected (no git-option smuggling)", async () => {
    const author = new FakeAuthor(text("x"))
    const { runner, calls } = fakeRunner(() => hasDiff("d"))
    const res = await drain(
      gitComposePrTool(runner, author).execute({ base: "--output=/etc/x" }, ctx()),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("must not begin with '-'")
    // never reached git
    expect(calls.length).toBe(0)
    expect(author.inputs.length).toBe(0)
  })

  test("log failure does not block authoring (best-effort context)", async () => {
    const { runner } = fakeRunner((args) =>
      args[0] === "log" ? fail("log boom") : hasDiff("diff --git a/x b/x"),
    )
    const author = new FakeAuthor(text("<TITLE>\nT\n</TITLE>\n<BODY>\nB\n</BODY>"))
    const res = await drain(gitComposePrTool(runner, author).execute({}, ctx()))
    expect(res.ok).toBe(true)
  })

  test("free-text author output → fallback parse, still ok:true", async () => {
    const { runner } = fakeRunner((args) => (args[0] === "log" ? ok("") : hasDiff("d")))
    const author = new FakeAuthor(text("My PR title\n\nThe body goes here."))
    const res = await drain(gitComposePrTool(runner, author).execute({}, ctx()))
    expect(res.ok).toBe(true)
    expect((res.structured as { structured: boolean }).structured).toBe(false)
  })
})

// ── default-OFF seam (byte-identical) ───────────────────────────────────────

describe("default-OFF registry seam", () => {
  test("absent authorLLM ⇒ compose tools NOT registered", () => {
    const names = gitTools(fakeRunner(() => ok("")).runner).map((t) => t.name)
    expect(names).not.toContain("git_compose_commit")
    expect(names).not.toContain("git_compose_pr")
  })

  test("present authorLLM ⇒ both compose tools registered, everything else unchanged", () => {
    const runner = fakeRunner(() => ok("")).runner
    const baseline = gitTools(runner).map((t) => t.name)
    const withAuthor = gitTools(runner, { authorLLM: new FakeAuthor(text("x")) }).map((t) => t.name)
    expect(withAuthor).toContain("git_compose_commit")
    expect(withAuthor).toContain("git_compose_pr")
    // the ONLY additions are the two compose tools — byte-identical otherwise
    expect(withAuthor.filter((n) => !baseline.includes(n)).sort()).toEqual([
      "git_compose_commit",
      "git_compose_pr",
    ])
    expect(baseline.every((n) => withAuthor.includes(n))).toBe(true)
  })
})

// ── ADR-0458: diff-derived scope inference ──────────────────────────────────

/** Build a minimal but realistic staged-diff section for one file with `adds`
 *  added + `dels` removed body lines. */
const fileSection = (path: string, adds = 1, dels = 0): string => {
  const lines = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@"]
  for (let i = 0; i < dels; i++) lines.push(`-old${i}`)
  for (let i = 0; i < adds; i++) lines.push(`+new${i}`)
  return lines.join("\n")
}

describe("diffToScopes (pure, deterministic)", () => {
  test("empty diff → no candidates", () => {
    expect(diffToScopes("")).toEqual([])
  })

  test("src/<seg>, packages/<seg>, apps/<seg> → first segment under the root", () => {
    expect(diffToScopes(fileSection("src/auth/login.ts"))).toEqual(["auth"])
    expect(diffToScopes(fileSection("packages/db/client.ts"))).toEqual(["db"])
    expect(diffToScopes(fileSection("apps/web/page.tsx"))).toEqual(["web"])
  })

  test("nested files under apps/<app>/src/... still vote for the app segment", () => {
    expect(diffToScopes(fileSection("apps/web/src/components/Btn.tsx"))).toEqual(["web"])
  })

  test("root-level files → NO candidates (byte-identical regression anchor)", () => {
    const diff = [fileSection("README.md"), fileSection("package.json")].join("\n")
    expect(diffToScopes(diff)).toEqual([])
  })

  test("file directly under a root with no further segment → no scope", () => {
    expect(diffToScopes(fileSection("src/index.ts"))).toEqual([])
  })

  test("unrecognized root (e.g. test/, vendor/) → no scope", () => {
    expect(diffToScopes(fileSection("test/foo/bar.ts"))).toEqual([])
    expect(diffToScopes(fileSection("vendor/x/y.ts"))).toEqual([])
  })

  test("multi-module → ordered most-touched (files) first", () => {
    // auth: 2 files, ui: 1 file → auth ranks first regardless of line counts.
    const diff = [
      fileSection("src/auth/a.ts"),
      fileSection("src/auth/b.ts"),
      fileSection("src/ui/c.ts", 50),
    ].join("\n")
    expect(diffToScopes(diff)).toEqual(["auth", "ui"])
  })

  test("tie on files broken by lines-changed DESC", () => {
    // both 1 file; ui has more changed lines → ui first.
    const diff = [fileSection("src/auth/a.ts", 1), fileSection("src/ui/c.ts", 9, 9)].join("\n")
    expect(diffToScopes(diff)).toEqual(["ui", "auth"])
  })

  test("tie on files AND lines broken by scope name ASC (deterministic)", () => {
    const diff = [fileSection("src/zoo/a.ts", 3), fileSection("src/apple/b.ts", 3)].join("\n")
    expect(diffToScopes(diff)).toEqual(["apple", "zoo"])
  })

  test("de-duplicates: many files in one module → single candidate", () => {
    const diff = [
      fileSection("src/auth/a.ts"),
      fileSection("src/auth/b.ts"),
      fileSection("src/auth/c.ts"),
    ].join("\n")
    expect(diffToScopes(diff)).toEqual(["auth"])
  })

  test("pure deletion (+++ /dev/null) still votes via the pre-image path", () => {
    const diff = [
      "diff --git a/src/auth/old.ts b/src/auth/old.ts",
      "--- a/src/auth/old.ts",
      "+++ /dev/null",
      "@@ -1 +0 @@",
      "-gone",
    ].join("\n")
    expect(diffToScopes(diff)).toEqual(["auth"])
  })
})

describe("buildCommitAuthorPrompt: scope hint additive + byte-identical", () => {
  const diff = "diff --git a/x b/x\n+added"

  test("no candidates → prompt byte-identical to the no-hint path", () => {
    const withEmpty = buildCommitAuthorPrompt(diff, false, undefined, [])
    const without = buildCommitAuthorPrompt(diff, false, undefined)
    const withUndef = buildCommitAuthorPrompt(diff, false, undefined, undefined)
    expect(withEmpty).toBe(without)
    expect(withUndef).toBe(without)
    expect(without).not.toContain("Suggested scope")
  })

  test("candidates present → hint line listing the modules", () => {
    const p = buildCommitAuthorPrompt(diff, false, undefined, ["auth", "ui"])
    expect(p).toContain("Suggested scope")
    expect(p).toContain("auth, ui")
    expect(p).toContain("If none fit")
  })
})

describe("parseConventionalCommit: soft scope-off-suggestion signal", () => {
  test("authored scope NOT in suggestions → scopeOffSuggestion:true (no rejection)", () => {
    const p = parseConventionalCommit("feat(authentication): x", ["auth"])
    expect(p.conventional).toBe(true) // still a valid, usable commit
    expect(p.scope).toBe("authentication")
    expect(p.scopeOffSuggestion).toBe(true)
  })

  test("authored scope IN suggestions → scopeOffSuggestion:false", () => {
    const p = parseConventionalCommit("feat(auth): x", ["auth", "ui"])
    expect(p.scopeOffSuggestion).toBe(false)
  })

  test("no suggestions → field absent (byte-identical structured payload)", () => {
    const p = parseConventionalCommit("feat(auth): x")
    expect("scopeOffSuggestion" in p).toBe(false)
    const pEmpty = parseConventionalCommit("feat(auth): x", [])
    expect("scopeOffSuggestion" in pEmpty).toBe(false)
  })

  test("no authored scope but suggestions present → field absent (nothing to flag)", () => {
    const p = parseConventionalCommit("feat: x", ["auth"])
    expect(p.scope).toBeUndefined()
    expect("scopeOffSuggestion" in p).toBe(false)
  })
})

describe("git_compose_commit: end-to-end scope hint wiring", () => {
  test("scoped diff → author prompt carries the suggested scope", async () => {
    const author = new FakeAuthor(text("feat(auth): add login"))
    const t = gitComposeCommitTool(
      fakeRunner(() => hasDiff(fileSection("src/auth/login.ts"))).runner,
      author,
    )
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(true)
    const sent = author.inputs[0]?.messages[0]?.content[0] as { type: "text"; text: string }
    expect(sent.text).toContain("Suggested scope")
    expect(sent.text).toContain("auth")
    // scope matched the suggestion → soft signal false
    expect((res.structured as { scopeOffSuggestion?: boolean }).scopeOffSuggestion).toBe(false)
  })

  test("root-only diff → NO hint line (byte-identical prompt) + no soft signal", async () => {
    const author = new FakeAuthor(text("docs: update readme"))
    const t = gitComposeCommitTool(
      fakeRunner(() => hasDiff(fileSection("README.md"))).runner,
      author,
    )
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(true)
    const sent = author.inputs[0]?.messages[0]?.content[0] as { type: "text"; text: string }
    expect(sent.text).not.toContain("Suggested scope")
    expect("scopeOffSuggestion" in (res.structured as object)).toBe(false)
  })

  test("author drifts off the suggested scope → soft signal true, commit NOT blocked", async () => {
    const author = new FakeAuthor(text("feat(authentication): add login"))
    const t = gitComposeCommitTool(
      fakeRunner(() => hasDiff(fileSection("src/auth/login.ts"))).runner,
      author,
    )
    const res = await drain(t.execute({}, ctx()))
    expect(res.ok).toBe(true) // never a rejection
    expect((res.structured as { scopeOffSuggestion?: boolean }).scopeOffSuggestion).toBe(true)
  })
})
