/**
 * ADR-0311 integration — end-to-end happy path on the GH Actions slice.
 *
 * Fake fs (event JSON in memory) + fake gh (canned responses) + identity
 * redact. Exercises trigger emit → context load → comment post with marker.
 */

import { describe, expect, test } from "bun:test"

import {
  computeIdempotencyKey,
  createActionsEventSource,
  createDeliveryStore,
  createPrOutputSink,
  loadPrContext,
  type RedactPort,
} from "@/integrations/github"

import {
  envFromMap,
  fakeFs,
  fakeGhPort,
  fixedClock,
  ok,
  okText,
} from "../../../unit/integrations/github/_helpers"

const eventJson = JSON.stringify({
  action: "created",
  repository: { owner: { login: "octo" }, name: "demo" },
  sender: { login: "alice", type: "User" },
  issue: { number: 7, pull_request: {} },
  comment: { body: "@quanta please review", author_association: "COLLABORATOR" },
})

const viewJson = ok({
  title: "Fix",
  body: "",
  baseRefName: "main",
  headRefName: "x",
  baseRefOid: "b1",
  headRefOid: "h1",
  number: 7,
})

const filesJson = ok([{ filename: "src/a.ts" }])
const commentsJson = ok([])

const passthroughRedact: RedactPort = { redact: (t) => t }

describe("ADR-0311 — GitHub Actions end-to-end", () => {
  test("event → trigger → context → comment with marker", async () => {
    const fs = fakeFs({ "/e.json": eventJson })

    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/e.json",
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_DELIVERY: "e2e-1",
      }),
      clockPort: fixedClock(0),
      deliveryStore: createDeliveryStore(),
    })

    const triggers = await src.poll()
    expect(triggers.length).toBe(1)
    const t = triggers[0]
    if (t === undefined) throw new Error("unreachable")
    expect(t.reason).toBe("pr_comment")
    expect(t.evidence.value).toBe("https://github.com/octo/demo/pull/7")

    const gh = fakeGhPort([
      { match: (a) => a[0] === "pr" && a[1] === "view", result: viewJson },
      {
        match: (a) => a[0] === "pr" && a[1] === "diff",
        result: okText("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n"),
      },
      { match: (a) => a[0] === "api" && a[1]?.includes("/files") === true, result: filesJson },
      {
        match: (a) => a[0] === "api" && a[1]?.includes("/comments?per_page=20") === true,
        result: commentsJson,
      },
      // Sink's existence-check GET (per_page=100)
      { match: (a) => a[0] === "api" && a[1]?.includes("per_page=100") === true, result: ok([]) },
      // Sink's POST
      { match: (a) => a.includes("POST"), result: ok({ html_url: "https://example/c/posted" }) },
    ])

    const ctx = await loadPrContext({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "octo/demo",
      prNumber: 7,
    })
    expect(ctx).toBeDefined()
    if (ctx === undefined) throw new Error("unreachable")
    expect(ctx.title).toBe("Fix")
    expect(ctx.headSha).toBe("h1")

    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "octo/demo",
      prNumber: 7,
      redactPort: passthroughRedact,
    })
    const key = computeIdempotencyKey("e2e-1", "issue_comment.created")
    const res = await sink.postComment({ body: "thanks, reviewed", key })
    expect(res.ok).toBe(true)
    expect(res.url).toBe("https://example/c/posted")

    const postCall = gh.calls.find((c) => c.args.includes("POST"))
    expect(postCall).toBeDefined()
    const bodyArg = postCall?.args.find((a) => a.startsWith("body="))
    expect(bodyArg).toContain("thanks, reviewed")
    expect(bodyArg).toContain("<!-- quanta:idempotency=")
    expect(bodyArg).toContain(key)
  })

  test("second poll for the same event yields []", async () => {
    const fs = fakeFs({ "/e.json": eventJson })
    const store = createDeliveryStore()
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/e.json",
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_DELIVERY: "e2e-stable",
      }),
      clockPort: fixedClock(0),
      deliveryStore: store,
    })
    expect((await src.poll()).length).toBe(1)
    expect(await src.poll()).toEqual([])
    expect(await src.poll()).toEqual([])
  })
})
