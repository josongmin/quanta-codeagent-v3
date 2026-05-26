/**
 * ADR-0311/0313 hellgate R3 — `from-pr` CLI with REAL node-fs + REAL redact
 * adapters. Round-2 used an ad-hoc L2 real-IO driver; this elevates that
 * driver into a maintained unit-test so the production redact path stays
 * exercised even when nobody re-runs the live workflow.
 *
 * What is real vs fake:
 *   - REAL `createNodeFsPort` (`node:fs/promises` `readFile`/`stat`).
 *   - REAL `createRedactPort` (wraps production `redactSecrets`).
 *   - REAL `createSystemClockPort` (Date.now()).
 *   - FAKE `EnvPort` (constructed per test from a map).
 *   - FAKE `GhCliPort` (no subprocess spawned).
 *
 * Each test writes a real `GITHUB_EVENT_PATH` JSON into a real `mkdtemp`
 * directory, runs `runFromPrCmd`, and asserts ports were exercised AND the
 * outgoing post body has no raw secret bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FromPrCmdEvent, runFromPrCmd } from "@/apps/cli/from-pr-cmd"
import {
  createNodeFsPort,
  createRedactPort,
  createSystemClockPort,
} from "@/apps/cli/from-pr-cmd-adapters"
import { createDeliveryStore } from "@/integrations/github"
import type { EnvPort, GhCliPort, GhCliResult } from "@/reactor"

interface RealCtx {
  readonly dir: string
  readonly eventPath: string
}

let ctx: RealCtx

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "quanta-r3-cli-"))
  ctx = { dir, eventPath: join(dir, "event.json") }
})

afterEach(async () => {
  if (ctx === undefined) return
  await rm(ctx.dir, { recursive: true, force: true }).catch(() => undefined)
})

const writeEvent = async (path: string, obj: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(obj), { encoding: "utf8" })
}

const writeRawBytes = async (path: string, bytes: Uint8Array): Promise<void> => {
  await writeFile(path, bytes)
}

const envFromMap = (m: Record<string, string | undefined>): EnvPort => ({
  get: (name) => m[name],
})

const baseEnv = (extra: Record<string, string | undefined> = {}): Record<string, string> => ({
  QUANTA_GH_ACTIONS_TRIGGER: "1",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_EVENT_PATH: ctx.eventPath,
  GITHUB_EVENT_NAME: "issue_comment",
  GITHUB_DELIVERY: "real-delivery-1",
  ...(Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >),
})

interface GhCall {
  readonly args: readonly string[]
}

const buildGhStub = (prBody: string, postCallSink?: GhCall[]): GhCliPort => ({
  async run(args): Promise<GhCliResult> {
    postCallSink?.push({ args })
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          title: "Add feature",
          body: prBody,
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
      return { stdout: "--- a\n+++ b\n", stderr: "", exitCode: 0 }
    }
    if (args[0] === "api" && args[1]?.includes("/files") === true) {
      return { stdout: JSON.stringify([{ filename: "src/x.ts" }]), stderr: "", exitCode: 0 }
    }
    if (
      args[0] === "api" &&
      args[1] === "--method" &&
      args[2] === "POST" &&
      args[3]?.includes("/comments") === true
    ) {
      return {
        stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/issuecomment-1" }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args[0] === "api" && args[1]?.includes("/comments") === true) {
      return { stdout: "[]", stderr: "", exitCode: 0 }
    }
    return { stdout: "", stderr: "unhandled", exitCode: 1 }
  },
})

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

const findPostBody = (calls: readonly GhCall[]): string | undefined => {
  const post = calls.find((c) => c.args.includes("POST"))
  return post?.args.find((a) => a.startsWith("body="))
}

describe("ADR-0311 hellgate R3 — CLI with real node-fs + real redact", () => {
  test("env-off → trigger 0 (real fs untouched semantically)", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload())
    const env = envFromMap({})
    const calls: GhCall[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: env,
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.triggers).toBe(0)
    expect(calls.length).toBe(0)
  })

  test("valid mention + real fs + real redact → posted body has [REDACTED:openai_api_key]", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload())
    const env = envFromMap(baseEnv())
    const leakedKey = `sk-${"A".repeat(48)}`
    const calls: GhCall[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: env,
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub(`leaked: ${leakedKey}`, calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.posted).toBe(true)
    const body = findPostBody(calls)
    expect(body).toBeDefined()
    expect(body).toContain("[REDACTED:openai_api_key]")
    expect(body).not.toContain(leakedKey)
  })

  test("proj-key in PR body → redacted in posted body", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload())
    const projKey = "sk-proj-abc_def-GHI_jkl-mno_pqr-stuvwxyz0123456789ABCDEF"
    const calls: GhCall[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub(`PROJ: ${projKey}`, calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.posted).toBe(true)
    const body = findPostBody(calls)
    expect(body).toContain("[REDACTED:openai_api_key]")
    expect(body).not.toContain(projKey)
  })

  test("anthropic key in PR body → redacted in posted body", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload())
    const antKey = `sk-ant-api03-${"X".repeat(80)}`
    const calls: GhCall[] = []
    await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub(`ant: ${antKey}`, calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    const body = findPostBody(calls)
    expect(body).toContain("[REDACTED:anthropic_api_key]")
    expect(body).not.toContain(antKey)
  })

  test("code-block @quanta → trigger 0 (no post)", async () => {
    await writeEvent(
      ctx.eventPath,
      makeIssueCommentPayload({ body: "see this code:\n```\n@quanta review\n```\nthanks" }),
    )
    const calls: GhCall[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.triggers).toBe(0)
    expect(findPostBody(calls)).toBeUndefined()
  })

  test("bot sender → trigger 0 (no post)", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload({ bot: true }))
    const calls: GhCall[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.triggers).toBe(0)
    expect(findPostBody(calls)).toBeUndefined()
  })

  test("non-collaborator (default scope) → trigger 0 (no post)", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload({ collaborator: false }))
    const calls: GhCall[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.triggers).toBe(0)
    expect(findPostBody(calls)).toBeUndefined()
  })

  test("malformed event JSON (real bad bytes on disk) → no throw, trigger 0", async () => {
    await writeRawBytes(ctx.eventPath, new TextEncoder().encode("not json{{not"))
    const calls: GhCall[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.triggers).toBe(0)
  })

  test("event file containing NUL byte → no throw, trigger 0 (defensive reject)", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(`{"a":1`),
      0x00,
      ...new TextEncoder().encode("}"),
    ])
    await writeRawBytes(ctx.eventPath, bytes)
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", []),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.triggers).toBe(0)
  })

  test("valid event with empty PR body → no throw, trigger 0 (no @quanta to match)", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload({ body: "" }))
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", []),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.triggers).toBe(0)
  })

  test("dryRun mode → no POST call to gh subprocess", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload())
    const calls: GhCall[] = []
    const events: FromPrCmdEvent[] = []
    const res = await runFromPrCmd(
      { dryRun: true },
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
        onEvent: (e) => events.push(e),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.posted).toBe(false)
    expect(events.find((e) => e.type === "dry-run-body")).toBeDefined()
    expect(calls.find((c) => c.args.includes("POST"))).toBeUndefined()
  })

  test("abort signal pre-poll → trigger 0", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload())
    const ac = new AbortController()
    ac.abort()
    const calls: GhCall[] = []
    const events: FromPrCmdEvent[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
        signal: ac.signal,
        onEvent: (e) => events.push(e),
      },
    )
    expect(res.triggers).toBe(0)
    expect(events.find((e) => e.type === "skipped" && e.reason === "abort")).toBeDefined()
    expect(calls.length).toBe(0)
  })

  test("idempotency: same delivery 2x → 2nd run yields 0 triggers", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload())
    const store = createDeliveryStore()
    const shared = {
      envPort: envFromMap(baseEnv()),
      fsPort: createNodeFsPort(),
      ghCliPort: buildGhStub("ok", []),
      clockPort: createSystemClockPort(),
      redactPort: createRedactPort(),
      deliveryStore: store,
    }
    const a = await runFromPrCmd({ dryRun: true }, shared)
    const b = await runFromPrCmd({ dryRun: true }, shared)
    expect(a.triggers).toBe(1)
    expect(b.triggers).toBe(0)
  })

  test("composite — proj-key + anthropic + ghp in one body → all 3 kinds in post", async () => {
    await writeEvent(ctx.eventPath, makeIssueCommentPayload())
    const body = [
      `pkey=${"sk-proj-" + "abcDEF12".repeat(4)}`,
      `akey=sk-ant-${"X".repeat(40)}`,
      `gh=ghp_${"Y".repeat(36)}`,
    ].join("\n")
    const calls: GhCall[] = []
    await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub(body, calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    const posted = findPostBody(calls)
    expect(posted).toContain("[REDACTED:openai_api_key]")
    expect(posted).toContain("[REDACTED:anthropic_api_key]")
    expect(posted).toContain("[REDACTED:github_pat_classic]")
    expect(posted).not.toContain("sk-proj-abcDEF12")
    expect(posted).not.toContain("sk-ant-XXXX")
    expect(posted).not.toContain("ghp_YYYY")
  })

  test("missing event file path → no throw, trigger 0", async () => {
    // No writeEvent — file absent. Reader collapses to undefined.
    const calls: GhCall[] = []
    const res = await runFromPrCmd(
      {},
      {
        envPort: envFromMap(baseEnv()),
        fsPort: createNodeFsPort(),
        ghCliPort: buildGhStub("ok", calls),
        clockPort: createSystemClockPort(),
        redactPort: createRedactPort(),
      },
    )
    expect(res.exitCode).toBe(0)
    expect(res.triggers).toBe(0)
  })
})
