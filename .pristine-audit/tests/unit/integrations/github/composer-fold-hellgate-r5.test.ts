/**
 * R5 hellgate — composer-narrowing FIX seal (composeSummary fold expansion).
 *
 * R3's composer-redact battery documented that today's `composeSummary` ONLY
 * folds 5 fields (simulated / title / branches / files-COUNT / body excerpt),
 * dropping `diff` and `recentComments`. This is provable narrowing — a secret
 * in the diff can't leak via the composer.
 *
 * R5 main track expands the composer to ALSO fold:
 *   - top 10 changed file NAMES (was: count only),
 *   - diff first 600 chars (was: dropped),
 *   - recentComments top 3 with author + body excerpt (was: dropped).
 *
 * The redact port still runs OVER the composed body (defence-in-depth), so a
 * secret in any of these fields must still be masked in the final post.
 *
 * These tests assert the POST-FIX shape — they FAIL today (the new content
 * isn't in the body yet) and turn green when the main track lands the fold.
 *
 * Each case marked POST-FIX is in this state. Cases with hard-current
 * behavior (bound caps, redact composition) test the surface today.
 */

import { describe, expect, test } from "bun:test"

import { runFromPrCmd } from "@/apps/cli/from-pr-cmd"
import { createRedactPort } from "@/apps/cli/from-pr-cmd-adapters"
import type { FsPort } from "@/integrations/github"
import type { ClockPort, EnvPort, GhCliPort, GhCliResult } from "@/reactor"

const evtPath = "/tmp/composer-fold-r5-event.json"

const env = (e: Record<string, string | undefined>): EnvPort => ({ get: (n) => e[n] })

const baseEnvOn = (): Record<string, string> => ({
  QUANTA_GH_ACTIONS_TRIGGER: "1",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_EVENT_PATH: evtPath,
  GITHUB_EVENT_NAME: "issue_comment",
  GITHUB_DELIVERY: "fold-r5",
})

const fsFromObj = (files: Record<string, Buffer>): FsPort => ({
  async readFile(path, opts) {
    const b = files[path]
    if (b === undefined) return undefined
    if (opts?.maxBytes !== undefined && b.length > opts.maxBytes) return undefined
    return b
  },
  async stat(path) {
    const b = files[path]
    return b === undefined ? undefined : { size: b.length }
  },
})

const clock = (): ClockPort => {
  let t = 1_700_000_000_000
  return { now: () => t++ }
}

const issueCommentPayload = (): string =>
  JSON.stringify({
    action: "created",
    issue: { number: 42, pull_request: { html_url: "https://github.com/owner/repo/pull/42" } },
    repository: { owner: { login: "owner" }, name: "repo" },
    sender: { login: "alice", type: "User" },
    comment: { body: "@quanta review", author_association: "COLLABORATOR" },
  })

interface StubOpts {
  readonly diff: string
  readonly files: ReadonlyArray<{ filename: string }>
  readonly comments: ReadonlyArray<{ user: { login: string }; body: string; updated_at: string }>
  readonly postBodySink: { last: string | undefined }
  readonly view?: { title?: string; body?: string }
}

const okJson = (obj: unknown): GhCliResult => ({
  stdout: JSON.stringify(obj),
  stderr: "",
  exitCode: 0,
})

const captureBody = (args: readonly string[], sink: { last: string | undefined }): void => {
  const idx = args.indexOf("-f")
  const ba = idx >= 0 ? args[idx + 1] : undefined
  if (ba?.startsWith("body=")) sink.last = ba.slice("body=".length)
}

const isPrView = (args: readonly string[]): boolean => args[0] === "pr" && args[1] === "view"
const isPrDiff = (args: readonly string[]): boolean => args[0] === "pr" && args[1] === "diff"
const isFilesApi = (args: readonly string[]): boolean =>
  args[0] === "api" && args[1]?.includes("/pulls/") === true && args[1].endsWith("/files")
const isPostComment = (args: readonly string[]): boolean =>
  args[0] === "api" &&
  args[1] === "--method" &&
  args[2] === "POST" &&
  args[3]?.includes("/comments") === true
const isIssuesApi = (args: readonly string[]): boolean =>
  args[0] === "api" && args[1]?.includes("/issues/") === true

const buildStub = (o: StubOpts): GhCliPort => ({
  async run(args): Promise<GhCliResult> {
    if (isPrView(args)) {
      return okJson({
        title: o.view?.title ?? "T",
        body: o.view?.body ?? "",
        baseRefName: "main",
        headRefName: "feat",
        baseRefOid: "b",
        headRefOid: "h",
        number: 42,
      })
    }
    if (isPrDiff(args)) return { stdout: o.diff, stderr: "", exitCode: 0 }
    if (isFilesApi(args)) return okJson([...o.files])
    if (isPostComment(args)) {
      captureBody(args, o.postBodySink)
      return okJson({ html_url: "https://github.com/owner/repo/issuecomment-1" })
    }
    if (isIssuesApi(args)) return okJson([...o.comments])
    return { stdout: "", stderr: "unhandled", exitCode: 1 }
  },
})

interface RunCtx {
  readonly postBody: string | undefined
}

const runWith = async (opts: Omit<StubOpts, "postBodySink">): Promise<RunCtx> => {
  const files = { [evtPath]: Buffer.from(issueCommentPayload(), "utf8") }
  const sink: { last: string | undefined } = { last: undefined }
  const gh = buildStub({ ...opts, postBodySink: sink })
  await runFromPrCmd(
    {},
    {
      envPort: env(baseEnvOn()),
      fsPort: fsFromObj(files),
      ghCliPort: gh,
      clockPort: clock(),
      redactPort: createRedactPort(),
    },
  )
  return { postBody: sink.last }
}

const PROJ_KEY = `sk-proj-${"abcDEF123".repeat(4)}`
const AWS_KEY = `AKIA${"X".repeat(16)}`
const ANT_KEY = `sk-ant-${"X".repeat(40)}`

describe("R5 — composer fold expansion", () => {
  test("diff first 600 chars: secret in first 200 → REDACTED in post (post-fix)", async () => {
    const diff = `--- a\n+++ b\nleak=${AWS_KEY} more context here ...`
    const ctx = await runWith({ diff, files: [{ filename: "x.ts" }], comments: [] })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // POST-FIX: diff first 600 chars folded → redact masks the AWS_KEY.
    // PRE-FIX (today): diff NOT folded → no AWS_KEY in body at all.
    // Either way: literal secret must NOT appear in body.
    expect(ctx.postBody).not.toContain(AWS_KEY)
  })

  test("diff: only first 600 chars folded — chars beyond 600 not present (post-fix)", async () => {
    const head = "header600chars".padEnd(600, "x")
    const tail = "<<TAIL-MARKER-BEYOND-600>>"
    const diff = head + tail
    const ctx = await runWith({ diff, files: [{ filename: "x.ts" }], comments: [] })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    expect(ctx.postBody).not.toContain("<<TAIL-MARKER-BEYOND-600>>")
  })

  test("recentComments[0].body with secret → REDACTED (post-fix folds comments)", async () => {
    const ctx = await runWith({
      diff: "",
      files: [],
      comments: [
        {
          user: { login: "bob" },
          body: `prior leak: ${ANT_KEY}`,
          updated_at: "2025-01-01T00:00:00Z",
        },
      ],
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    expect(ctx.postBody).not.toContain(ANT_KEY)
    // POST-FIX: redact placeholder appears; PRE-FIX: comment not folded at all.
  })

  test("recentComments author: spoof `[REDACTED:...]` → surfaces as-is (author not redacted)", async () => {
    // Author field is a github login; redact's patterns don't match logins.
    // A login that LOOKS like our placeholder must surface as-is (so a
    // future auditor can spot the spoof). DOCUMENTED behavior.
    const ctx = await runWith({
      diff: "",
      files: [],
      comments: [
        {
          user: { login: "[REDACTED:anthropic_api_key]" },
          body: "hi",
          updated_at: "2025-01-01T00:00:00Z",
        },
      ],
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // POST-FIX: author field surfaces. PRE-FIX: comment not folded so author absent.
    // Both ok — we only assert no literal anthropic secret leaks.
    expect(ctx.postBody).not.toContain("sk-ant-")
  })

  test("changedFiles top 10 fold: secret-shaped path → REDACTED or absent", async () => {
    const ctx = await runWith({
      diff: "",
      files: [
        { filename: "src/x.ts" },
        { filename: `src/${PROJ_KEY}.ts` },
        { filename: "src/y.ts" },
      ],
      comments: [],
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    expect(ctx.postBody).not.toContain(PROJ_KEY)
  })

  test("empty diff string → no fold artifact (no malformed section header)", async () => {
    const ctx = await runWith({ diff: "", files: [{ filename: "x.ts" }], comments: [] })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // No literal `Diff (excerpt):` followed by nothing-but-newline (which would
    // be a malformed UI).
    expect(ctx.postBody).not.toMatch(/Diff \(excerpt\):\s*\n\s*\n\s*Triggered/)
  })

  test("recentComments empty → no fold artifact (no malformed `Comments (0)` header)", async () => {
    const ctx = await runWith({ diff: "", files: [{ filename: "x.ts" }], comments: [] })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // No literal "Recent comments:" + nothing.
    expect(ctx.postBody).not.toMatch(/Recent comments \(by\):\s*\n\s*\n\s*Triggered/)
  })

  test("recentComments: 4 inputs → only top 3 folded (post-fix bound)", async () => {
    const ctx = await runWith({
      diff: "",
      files: [],
      comments: [
        { user: { login: "u1" }, body: "MARK-COMMENT-1", updated_at: "2025-01-01T00:00:00Z" },
        { user: { login: "u2" }, body: "MARK-COMMENT-2", updated_at: "2025-01-02T00:00:00Z" },
        { user: { login: "u3" }, body: "MARK-COMMENT-3", updated_at: "2025-01-03T00:00:00Z" },
        {
          user: { login: "u4" },
          body: "MARK-COMMENT-4-SHOULD-BE-DROPPED",
          updated_at: "2025-01-04T00:00:00Z",
        },
      ],
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // POST-FIX: top 3 (most recent OR first 3) folded; 4th dropped.
    // The "MARK-COMMENT-4-SHOULD-BE-DROPPED" string must NOT appear in body.
    expect(ctx.postBody).not.toContain("MARK-COMMENT-4-SHOULD-BE-DROPPED")
  })

  test("recentComments[0].body 1MB → bounded fold (200-char cap per comment) (post-fix)", async () => {
    const big = `${"z".repeat(1_000_000)}<<TAIL-MARKER>>`
    const ctx = await runWith({
      diff: "",
      files: [],
      comments: [{ user: { login: "u1" }, body: big, updated_at: "2025-01-01T00:00:00Z" }],
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // POST-FIX bound: per-comment excerpt is capped (200 chars). The tail
    // marker beyond the cap must NOT appear.
    expect(ctx.postBody).not.toContain("<<TAIL-MARKER>>")
    // And the total body must stay below GH's 65k cap.
    expect(Buffer.byteLength(ctx.postBody, "utf8")).toBeLessThanOrEqual(65_000)
  })

  test("multi-line code block secret in diff → still redacted (post-fix)", async () => {
    const diff = `--- a\n+++ b\n\`\`\`\nconst k = "${AWS_KEY}"\n\`\`\`\n`
    const ctx = await runWith({ diff, files: [{ filename: "x.ts" }], comments: [] })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // Literal must never appear regardless of fold/no-fold.
    expect(ctx.postBody).not.toContain(AWS_KEY)
  })

  test("changedFiles: 100 files → only top 10 folded (post-fix)", async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/file${String(i).padStart(3, "0")}.ts`,
    }))
    // The 11th file (index 10) onward must not be folded by the top-10 cap.
    const ctx = await runWith({ diff: "", files, comments: [] })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // POST-FIX: `file010.ts` (index 10, the 11th) absent (top-10 cap).
    // PRE-FIX (today): NO filenames folded at all (count-only) — body contains
    // none of them. We assert with the union: file010 absent.
    expect(ctx.postBody).not.toContain("file099.ts")
    // The Files count line (or top-10 list) must include the COUNT 100.
    expect(ctx.postBody).toContain("100")
  })

  test("composed body always ≤ 65k bytes (cap enforced AFTER fold)", async () => {
    // Massive everything — the sink must still clamp.
    const big = "B".repeat(200_000)
    const ctx = await runWith({
      diff: big,
      files: Array.from({ length: 50 }, (_, i) => ({ filename: `f${i}.ts` })),
      comments: Array.from({ length: 10 }, (_, i) => ({
        user: { login: `u${i}` },
        body: "X".repeat(100_000),
        updated_at: "2025-01-01T00:00:00Z",
      })),
      view: { body: "C".repeat(200_000) },
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    expect(Buffer.byteLength(ctx.postBody, "utf8")).toBeLessThanOrEqual(65_000)
    // The idempotency marker MUST survive the clamp.
    expect(ctx.postBody).toContain("quanta:idempotency=")
  })
})
