/**
 * `from-pr` CLI unit tests — all IO faked (env / fs / gh / clock / redact).
 *
 * Covers the 12 critical branches: env-off, no event, malformed event,
 * mention + post, dry-run, redaction, gh exit !=0, idempotent re-run,
 * non-collaborator, bot sender, code-block mention, abort mid-poll.
 */

import { describe, expect, it } from "bun:test"
import { type FromPrCmdEvent, runFromPrCmd } from "@/apps/cli/from-pr-cmd"
import {
  computeIdempotencyKey,
  createDeliveryStore,
  type FsPort,
  type RedactPort,
} from "@/integrations/github"
import type { ClockPort, EnvPort, GhCliPort, GhCliResult } from "@/reactor"

interface FakeEnv {
  GITHUB_REPOSITORY?: string
  GITHUB_EVENT_PATH?: string
  GITHUB_EVENT_NAME?: string
  GITHUB_DELIVERY?: string
  QUANTA_GH_ACTIONS_TRIGGER?: string
}

const env = (e: FakeEnv): EnvPort => ({
  get(name) {
    return (e as Record<string, string | undefined>)[name]
  },
})

const fsFromMap = (files: Map<string, Buffer>): FsPort => ({
  async readFile(path, opts) {
    const b = files.get(path)
    if (b === undefined) return undefined
    if (opts?.maxBytes !== undefined && b.length > opts.maxBytes) return undefined
    return b
  },
  async stat(path) {
    const b = files.get(path)
    return b === undefined ? undefined : { size: b.length }
  },
})

const clock = (start: number = 1_700_000_000_000): ClockPort => {
  let t = start
  return { now: () => t++ }
}

const passthroughRedact: RedactPort = {
  redact: (s) => s,
}

const stripRedact: RedactPort = {
  redact: (s) => s.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]"),
}

type GhStub = (args: readonly string[]) => GhCliResult | Promise<GhCliResult>

const stubGh = (stub: GhStub): GhCliPort => ({
  async run(args) {
    return await stub(args)
  },
})

const writeEvent = (files: Map<string, Buffer>, path: string, obj: unknown): void => {
  files.set(path, Buffer.from(JSON.stringify(obj), "utf8"))
}

const makeIssueCommentPayload = (
  overrides: Partial<{ body: string; bot: boolean; collaborator: boolean }> = {},
) => ({
  action: "created",
  issue: {
    number: 42,
    pull_request: { html_url: "https://github.com/owner/repo/pull/42" },
  },
  repository: { owner: { login: "owner" }, name: "repo" },
  sender: {
    login: overrides.bot === true ? "dependabot[bot]" : "alice",
    type: overrides.bot === true ? "Bot" : "User",
  },
  comment: {
    body: overrides.body ?? "@quanta review please",
    author_association: overrides.collaborator === false ? "NONE" : "COLLABORATOR",
  },
})

const evtPath = "/tmp/event.json"

const baseEnvOn = (extra: FakeEnv = {}): FakeEnv => ({
  QUANTA_GH_ACTIONS_TRIGGER: "1",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_EVENT_PATH: evtPath,
  GITHUB_EVENT_NAME: "issue_comment",
  GITHUB_DELIVERY: "delivery-1",
  ...extra,
})

const stubGhSuccessful = (): GhCliPort =>
  stubGh((args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          title: "Add feature",
          body: "PR description here",
          baseRefName: "main",
          headRefName: "feat",
          baseRefOid: "abc",
          headRefOid: "def",
          number: 42,
        }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "pr" && args[1] === "diff") {
      return { stdout: "diff --git ...", stderr: "", exitCode: 0 }
    }
    if (args[0] === "api" && args[1]?.includes("/pulls/") && args[1]?.endsWith("/files")) {
      return { stdout: JSON.stringify([{ filename: "src/x.ts" }]), stderr: "", exitCode: 0 }
    }
    if (
      args[0] === "api" &&
      args[1] === "--method" &&
      args[2] === "POST" &&
      args[3]?.includes("/comments")
    ) {
      return {
        stdout: JSON.stringify({
          html_url: "https://github.com/owner/repo/pull/42#issuecomment-1",
        }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "api" && args[1]?.includes("/issues/") && args[1]?.includes("/comments")) {
      return { stdout: "[]", stderr: "", exitCode: 0 }
    }
    return { stdout: "", stderr: "unhandled", exitCode: 1 }
  })

describe("runFromPrCmd", () => {
  it("env-off → exitCode 0 + skipped event", async () => {
    const events: FromPrCmdEvent[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: env({}),
        fsPort: fsFromMap(new Map()),
        ghCliPort: stubGh(() => ({ stdout: "", stderr: "", exitCode: 1 })),
        clockPort: clock(),
        redactPort: passthroughRedact,
        onEvent: (e) => events.push(e),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.triggers).toBe(0)
    expect(events.find((e) => e.type === "skipped" && e.reason === "env-off")).toBeDefined()
  })

  it("env-on + no event file → 0 triggers, no throw", async () => {
    const res = await runFromPrCmd(
      {},
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(new Map()),
        ghCliPort: stubGh(() => ({ stdout: "", stderr: "", exitCode: 1 })),
        clockPort: clock(),
        redactPort: passthroughRedact,
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.triggers).toBe(0)
  })

  it("env-on + malformed event → 0 triggers, no throw", async () => {
    const files = new Map<string, Buffer>([[evtPath, Buffer.from("not json{{", "utf8")]])
    const res = await runFromPrCmd(
      {},
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: stubGh(() => ({ stdout: "", stderr: "", exitCode: 1 })),
        clockPort: clock(),
        redactPort: passthroughRedact,
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.triggers).toBe(0)
  })

  it("env-on + valid mention + dryRun → context loaded + dry-run-body emitted", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(files, evtPath, makeIssueCommentPayload())
    const events: FromPrCmdEvent[] = []
    const res = await runFromPrCmd(
      { dryRun: true },
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: stubGhSuccessful(),
        clockPort: clock(),
        redactPort: passthroughRedact,
        onEvent: (e) => events.push(e),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.triggers).toBe(1)
    expect(res.contextLoaded).toBe(true)
    expect(res.posted).toBe(false)
    const dryRun = events.find((e) => e.type === "dry-run-body")
    expect(dryRun).toBeDefined()
  })

  it("env-on + valid mention + real post → posted true", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(files, evtPath, makeIssueCommentPayload())
    const events: FromPrCmdEvent[] = []
    const res = await runFromPrCmd(
      { dryRun: false },
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: stubGhSuccessful(),
        clockPort: clock(),
        redactPort: passthroughRedact,
        onEvent: (e) => events.push(e),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.posted).toBe(true)
    expect(events.find((e) => e.type === "posted")).toBeDefined()
  })

  it("redaction: API-key-like string in PR body is redacted before post", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(files, evtPath, makeIssueCommentPayload())
    let postedBody = ""
    const gh = stubGh((args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            title: "Add",
            body: "leak: sk-abcdef0123456789ABCDEF01234",
            baseRefName: "main",
            headRefName: "feat",
            baseRefOid: "a",
            headRefOid: "b",
          }),
          stderr: "",
          exitCode: 0,
        }
      }
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "", stderr: "", exitCode: 0 }
      if (args[0] === "api" && args[1]?.includes("/files"))
        return { stdout: "[]", stderr: "", exitCode: 0 }
      if (args[0] === "api" && args[1]?.includes("/comments"))
        return { stdout: "[]", stderr: "", exitCode: 0 }
      if (
        args[0] === "api" &&
        args[1] === "--method" &&
        args[2] === "POST" &&
        args[3]?.includes("/comments")
      ) {
        const idx = args.indexOf("-f")
        const bodyArg = idx >= 0 ? args[idx + 1] : undefined
        if (bodyArg !== undefined && bodyArg.startsWith("body=")) {
          postedBody = bodyArg.slice("body=".length)
        }
        return { stdout: JSON.stringify({ html_url: "url" }), stderr: "", exitCode: 0 }
      }
      if (args[0] === "api" && args[1]?.includes("/issues/") && args[1]?.includes("/comments")) {
        return { stdout: "[]", stderr: "", exitCode: 0 }
      }
      return { stdout: "", stderr: "", exitCode: 1 }
    })
    const res = await runFromPrCmd(
      {},
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: gh,
        clockPort: clock(),
        redactPort: stripRedact,
      },
    )
    expect(res.posted).toBe(true)
    expect(postedBody).toContain("[REDACTED]")
    expect(postedBody).not.toContain("sk-abcdef0123456789ABCDEF01234")
  })

  it("gh exit !=0 on context fetch → exitCode 1 + error set", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(files, evtPath, makeIssueCommentPayload())
    const gh = stubGh((args) => {
      if (args[0] === "pr" && args[1] === "view") return { stdout: "", stderr: "boom", exitCode: 4 }
      return { stdout: "", stderr: "", exitCode: 1 }
    })
    const res = await runFromPrCmd(
      {},
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: gh,
        clockPort: clock(),
        redactPort: passthroughRedact,
      },
    )
    expect(res.exitCode).toBe(1)
    expect(res.contextLoaded).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it("idempotent: same delivery-id 2x → 2nd run emits 0 triggers", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(files, evtPath, makeIssueCommentPayload())
    const store = createDeliveryStore()
    const sharedOpts = {
      envPort: env(baseEnvOn()),
      fsPort: fsFromMap(files),
      ghCliPort: stubGhSuccessful(),
      clockPort: clock(),
      redactPort: passthroughRedact,
      deliveryStore: store,
    }
    const a = await runFromPrCmd({ dryRun: true }, sharedOpts)
    const b = await runFromPrCmd({ dryRun: true }, sharedOpts)
    expect(a.triggers).toBe(1)
    expect(b.triggers).toBe(0)
  })

  it("non-collaborator + collaborator trust-scope (default) → trigger 0", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(files, evtPath, makeIssueCommentPayload({ collaborator: false }))
    const res = await runFromPrCmd(
      {},
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: stubGhSuccessful(),
        clockPort: clock(),
        redactPort: passthroughRedact,
      },
    )
    expect(res.triggers).toBe(0)
  })

  it("bot sender → trigger 0 (default allowBots=false)", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(files, evtPath, makeIssueCommentPayload({ bot: true }))
    const res = await runFromPrCmd(
      {},
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: stubGhSuccessful(),
        clockPort: clock(),
        redactPort: passthroughRedact,
      },
    )
    expect(res.triggers).toBe(0)
  })

  it("mention inside code block → trigger 0", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(
      files,
      evtPath,
      makeIssueCommentPayload({ body: "see this code:\n```\n@quanta review\n```\nthanks" }),
    )
    const res = await runFromPrCmd(
      {},
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: stubGhSuccessful(),
        clockPort: clock(),
        redactPort: passthroughRedact,
      },
    )
    expect(res.triggers).toBe(0)
  })

  it("aborted before poll → 0 triggers, skipped:abort", async () => {
    const files = new Map<string, Buffer>()
    writeEvent(files, evtPath, makeIssueCommentPayload())
    const ac = new AbortController()
    ac.abort()
    const events: FromPrCmdEvent[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(files),
        ghCliPort: stubGhSuccessful(),
        clockPort: clock(),
        redactPort: passthroughRedact,
        signal: ac.signal,
        onEvent: (e) => events.push(e),
      },
    )
    expect(res.triggers).toBe(0)
    expect(events.find((e) => e.type === "skipped" && e.reason === "abort")).toBeDefined()
  })

  it("event-source != actions → skipped + Tier 1 placeholder", async () => {
    const events: FromPrCmdEvent[] = []
    const res = await runFromPrCmd(
      { eventSource: "webhook" },
      {
        envPort: env(baseEnvOn()),
        fsPort: fsFromMap(new Map()),
        ghCliPort: stubGh(() => ({ stdout: "", stderr: "", exitCode: 1 })),
        clockPort: clock(),
        redactPort: passthroughRedact,
        onEvent: (e) => events.push(e),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(
      events.find(
        (e) => e.type === "skipped" && e.reason.startsWith("event-source-not-implemented"),
      ),
    ).toBeDefined()
  })

  it("idempotency key is deterministic per (delivery, action)", () => {
    const a = computeIdempotencyKey("delivery-1", "comment")
    const b = computeIdempotencyKey("delivery-1", "comment")
    const c = computeIdempotencyKey("delivery-2", "comment")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
