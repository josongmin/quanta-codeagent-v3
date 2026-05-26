/**
 * ADR-0311 / 0313 hellgate R3 — defence-in-depth on the composer path.
 *
 * `from-pr-cmd.ts#composeSummary` is the ONE place a `PrContext` is folded
 * into an outgoing comment body. Even though `loadPrContext` redacts nothing
 * (the loader is dumb), the sink ALWAYS runs `redactPort.redact(body)` before
 * any gh POST — defence-in-depth.
 *
 * This battery proves that for EVERY field of `PrContext` we could plausibly
 * carry a secret in, the production `redactSecrets` removes it from the
 * outgoing body. We do this by:
 *   - injecting one canonical secret per field (title / body / headBranch /
 *     baseBranch / changedFiles / diff / recentComments),
 *   - running `runFromPrCmd` with the real `createRedactPort` and a fake
 *     ghCliPort that captures the POST `body=`,
 *   - asserting EITHER (a) the secret never reaches the posted body (because
 *     the composer doesn't fold that field in — provable narrowing), OR (b)
 *     the secret is replaced with `[REDACTED:<kind>]`.
 *
 * We also surface a real finding: `composeSummary` ONLY folds 5 fields
 * (simulated, title, headBranch, baseBranch, changedFiles.length, body
 * excerpt). The `diff` and `recentComments` arrive in the PrContext but are
 * dropped by the composer — so a secret there cannot leak through this
 * surface. We document that with passthrough assertions.
 */

import { describe, expect, test } from "bun:test"

import { runFromPrCmd } from "@/apps/cli/from-pr-cmd"
import { createRedactPort } from "@/apps/cli/from-pr-cmd-adapters"
import type { FsPort } from "@/integrations/github"
import type { ClockPort, EnvPort, GhCliPort, GhCliResult } from "@/reactor"

const evtPath = "/tmp/composer-event.json"

const env = (e: Record<string, string | undefined>): EnvPort => ({
  get: (name) => e[name],
})

const baseEnvOn = (extra: Record<string, string | undefined> = {}): Record<string, string> => {
  const out: Record<string, string> = {
    QUANTA_GH_ACTIONS_TRIGGER: "1",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_EVENT_PATH: evtPath,
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_DELIVERY: "composer-1",
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

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

const issueCommentPayload = () =>
  JSON.stringify({
    action: "created",
    issue: { number: 42, pull_request: { html_url: "https://github.com/owner/repo/pull/42" } },
    repository: { owner: { login: "owner" }, name: "repo" },
    sender: { login: "alice", type: "User" },
    comment: { body: "@quanta review", author_association: "COLLABORATOR" },
  })

interface PrViewOverrides {
  readonly title?: string
  readonly body?: string
  readonly baseRefName?: string
  readonly headRefName?: string
  readonly baseRefOid?: string
  readonly headRefOid?: string
}

interface GhStubOpts {
  readonly view: PrViewOverrides
  readonly diff: string
  readonly files: ReadonlyArray<{ filename: string }>
  readonly comments: ReadonlyArray<{ user: { login: string }; body: string; updated_at: string }>
  readonly postBodySink: { last: string | undefined }
}

const buildStub = (o: GhStubOpts): GhCliPort => ({
  async run(args): Promise<GhCliResult> {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          title: o.view.title ?? "T",
          body: o.view.body ?? "",
          baseRefName: o.view.baseRefName ?? "main",
          headRefName: o.view.headRefName ?? "feat",
          baseRefOid: o.view.baseRefOid ?? "b",
          headRefOid: o.view.headRefOid ?? "h",
          number: 42,
        }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "pr" && args[1] === "diff") {
      return { stdout: o.diff, stderr: "", exitCode: 0 }
    }
    if (args[0] === "api" && args[1]?.includes("/pulls/") === true && args[1].endsWith("/files")) {
      return { stdout: JSON.stringify([...o.files]), stderr: "", exitCode: 0 }
    }
    if (
      args[0] === "api" &&
      args[1] === "--method" &&
      args[2] === "POST" &&
      args[3]?.includes("/comments") === true
    ) {
      const idx = args.indexOf("-f")
      const ba = idx >= 0 ? args[idx + 1] : undefined
      if (ba !== undefined && ba.startsWith("body=")) {
        o.postBodySink.last = ba.slice("body=".length)
      }
      return {
        stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/issuecomment-1" }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "api" && args[1]?.includes("/issues/") === true) {
      return { stdout: JSON.stringify([...o.comments]), stderr: "", exitCode: 0 }
    }
    return { stdout: "", stderr: "unhandled", exitCode: 1 }
  },
})

interface RunCtx {
  readonly postBody: string | undefined
}

const runWith = async (stubOpts: Omit<GhStubOpts, "postBodySink">): Promise<RunCtx> => {
  const files = { [evtPath]: Buffer.from(issueCommentPayload(), "utf8") }
  const sink: { last: string | undefined } = { last: undefined }
  const gh = buildStub({ ...stubOpts, postBodySink: sink })
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

const defaultStub: Omit<GhStubOpts, "postBodySink"> = {
  view: {},
  diff: "",
  files: [{ filename: "src/x.ts" }],
  comments: [],
}

const AWS_KEY = `AKIA${"X".repeat(16)}`
const PROJ_KEY = `sk-proj-${"abcDEF123".repeat(4)}`
const ANT_KEY = `sk-ant-${"X".repeat(40)}`
const GHP_KEY = `ghp_${"Y".repeat(40)}`
const STRIPE_KEY = `sk_live_${"X".repeat(30)}`

describe("ADR-0313 hellgate R3 — composer defence-in-depth", () => {
  test("secret in PR TITLE → redacted in posted body", async () => {
    const ctx = await runWith({ ...defaultStub, view: { title: `Add ${AWS_KEY} support` } })
    expect(ctx.postBody).toBeDefined()
    expect(ctx.postBody).toContain("[REDACTED:aws_access_key_id]")
    expect(ctx.postBody).not.toContain(AWS_KEY)
  })

  test("OpenAI proj-key in PR BODY → redacted in posted body", async () => {
    const ctx = await runWith({ ...defaultStub, view: { body: `leak: ${PROJ_KEY}` } })
    expect(ctx.postBody).toContain("[REDACTED:openai_api_key]")
    expect(ctx.postBody).not.toContain(PROJ_KEY)
  })

  test("Anthropic key in PR BODY → redacted in posted body", async () => {
    const ctx = await runWith({ ...defaultStub, view: { body: `ant: ${ANT_KEY}` } })
    expect(ctx.postBody).toContain("[REDACTED:anthropic_api_key]")
    expect(ctx.postBody).not.toContain(ANT_KEY)
  })

  test("GitHub PAT in headBranch (unrealistic but defence-in-depth) → redacted", async () => {
    // A branch name technically can't contain `_`/`-` patterns matching ghp_…
    // but the composer concatenates whatever loadPrContext returns. We prove
    // the redact catches it even via this surface.
    const ctx = await runWith({ ...defaultStub, view: { headRefName: GHP_KEY } })
    expect(ctx.postBody).toContain("[REDACTED:github_pat_classic]")
    expect(ctx.postBody).not.toContain(GHP_KEY)
  })

  test("Stripe key in baseBranch → redacted", async () => {
    const ctx = await runWith({ ...defaultStub, view: { baseRefName: STRIPE_KEY } })
    expect(ctx.postBody).toContain("[REDACTED:stripe_secret_key]")
    expect(ctx.postBody).not.toContain(STRIPE_KEY)
  })

  test("multiple secrets across title + body → all redacted in post", async () => {
    const ctx = await runWith({
      ...defaultStub,
      view: { title: `t ${AWS_KEY}`, body: `b ${GHP_KEY} c ${PROJ_KEY}` },
    })
    expect(ctx.postBody).toContain("[REDACTED:aws_access_key_id]")
    expect(ctx.postBody).toContain("[REDACTED:github_pat_classic]")
    expect(ctx.postBody).toContain("[REDACTED:openai_api_key]")
  })

  test("PR body OVER 1024-char excerpt cap is truncated BEFORE post", async () => {
    // Composer clamps to 1024-char excerpt. The trailing chars never reach
    // the post. We assert by putting a marker AFTER position 1024 and
    // verifying it's gone (this is documented narrowing — not a redact bug).
    const filler = "a".repeat(2048)
    const ctx = await runWith({
      ...defaultStub,
      view: { body: `${filler}<<TRAILING-MARKER>>` },
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    expect(ctx.postBody).not.toContain("<<TRAILING-MARKER>>")
    // The clamp suffix `…` is appended.
    expect(ctx.postBody).toMatch(/aaaa…/)
  })

  test("secret AT clamp-boundary (inside excerpt with word boundary) IS redacted", async () => {
    // If a secret fits ENTIRELY inside the 1024-char excerpt AND has a word
    // boundary (production regex anchors on `\b`), the redact path masks it.
    const lead = `${"a".repeat(900)} ` // trailing space gives the \b
    const body = `${lead}${AWS_KEY}`
    const ctx = await runWith({ ...defaultStub, view: { body } })
    expect(ctx.postBody).toContain("[REDACTED:aws_access_key_id]")
    expect(ctx.postBody).not.toContain(AWS_KEY)
  })

  test("documented redact narrowing: secret WITHOUT word boundary leaks (regex \\b anchor)", async () => {
    // Production `redactSecrets` patterns use `\b` anchors. A secret embedded
    // directly between word chars (no whitespace/punctuation) is NOT masked.
    // This is the documented redact contract — surfaced here so a future
    // hardener (or attacker) cannot claim it as a surprise.
    const ctx = await runWith({ ...defaultStub, view: { body: `xxx${AWS_KEY}yyy` } })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // The literal still appears (no \b around it). Document this so the
    // invariant is testable, not silent.
    expect(ctx.postBody).toContain(`xxx${AWS_KEY}yyy`)
  })

  test("R5: diff IS folded into composer body — secrets in diff get redacted", async () => {
    // R5 expanded composeSummary to fold the first 600 chars of diff. A secret
    // landing in that window MUST be redacted, NOT leaked raw.
    const ctx = await runWith({ ...defaultStub, diff: `--- a\n+++ b\n-key=${AWS_KEY}\n+key=...` })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    expect(ctx.postBody).not.toContain(AWS_KEY)
    expect(ctx.postBody).toContain("[REDACTED:aws_access_key_id]")
  })

  test("R5: recentComments ARE folded — secrets in prior comments get redacted", async () => {
    const ctx = await runWith({
      ...defaultStub,
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
    expect(ctx.postBody).toContain("[REDACTED:anthropic_api_key]")
  })

  test("R5: changedFiles paths fold top 10 by name — secret-like path is redacted (not raw)", async () => {
    const ctx = await runWith({
      ...defaultStub,
      files: [{ filename: "src/x.ts" }, { filename: `src/${PROJ_KEY}.ts` }],
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    // Path containing the proj-key shape MUST be redacted, not raw.
    expect(ctx.postBody).not.toContain(PROJ_KEY)
    expect(ctx.postBody).toMatch(/Files changed \(2\)/)
  })

  test("idempotency marker is appended AFTER redaction (never bypasses cap)", async () => {
    const ctx = await runWith({ ...defaultStub, view: { body: `b ${AWS_KEY}` } })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    expect(ctx.postBody).toContain("<!-- quanta:idempotency=")
    // The marker is AFTER the body, so the last 80 chars must include it.
    expect(ctx.postBody.slice(-80)).toContain("quanta:idempotency=")
  })

  test("secret-looking junk in branch name with non-matching shape passes through", async () => {
    // Negative control — branch like `feat-add-stripe-key-handler` LOOKS
    // secret-ish but is below threshold. Redact must NOT touch it.
    const ctx = await runWith({
      ...defaultStub,
      view: { headRefName: "feat-add-stripe-key-handler" },
    })
    expect(ctx.postBody).toBeDefined()
    if (ctx.postBody === undefined) throw new Error("unreachable")
    expect(ctx.postBody).toContain("feat-add-stripe-key-handler")
    expect(ctx.postBody).not.toContain("[REDACTED:")
  })
})
