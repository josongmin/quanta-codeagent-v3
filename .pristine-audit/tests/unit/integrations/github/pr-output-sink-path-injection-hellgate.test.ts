/**
 * ADR-0313 hellgate — repoSlug / prNumber boundary gate on the WRITE/DELETE
 * path (audit T12-github).
 *
 * The sink interpolates `repoSlug` / `prNumber` RAW into every
 * `gh api repos/<slug>/…` POST / PATCH / DELETE path. The sibling READ path
 * (reactor `trigger-source-pr-comment`) already guards these against path
 * traversal / query injection; the WRITE path did NOT. This battery proves
 * `createPrOutputSink` now refuses a hostile/misconfigured slug or number at
 * BOOT (mirroring the mandatory-redactPort throw) so a bad wire can never
 * produce a sink that rewrites the REST endpoint at the network boundary.
 *
 * Sibling style: `pr-output-sink-redaction-hellgate.test.ts`.
 */

import { describe, expect, test } from "bun:test"

import {
  computeIdempotencyKey,
  createActionsEventSource,
  createMentionFilter,
  createPrOutputSink,
} from "@/integrations/github"

import { envFromMap, fakeFs, fakeGhPort, fixedClock, identityRedact, ok } from "./_helpers"

const key = computeIdempotencyKey("h-delivery", "issue_comment")

const goodGh = () =>
  fakeGhPort([
    { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
    { match: (a) => a[0] === "api", result: ok([]) },
  ])

const makeSink = (over: { repoSlug?: unknown; prNumber?: unknown }) =>
  createPrOutputSink({
    ghCliPort: goodGh().port,
    repoCwd: "/r",
    repoSlug: (over.repoSlug ?? "o/r") as string,
    prNumber: (over.prNumber ?? 1) as number,
    redactPort: identityRedact,
  })

describe("ADR-0313 hellgate — repoSlug/prNumber boundary gate (WRITE path)", () => {
  test("legal owner/repo + positive int constructs fine", () => {
    expect(() => makeSink({ repoSlug: "octo/demo", prNumber: 7 })).not.toThrow()
    // hyphen / dot segments are legal GitHub slugs
    expect(() => makeSink({ repoSlug: "my-org.x/repo.js", prNumber: 1 })).not.toThrow()
  })

  test("query-injection slug throws at boot (would rewrite the REST endpoint)", () => {
    expect(() => makeSink({ repoSlug: "foo/bar/comments?per_page=1&x=" })).toThrow(/repoSlug/)
  })

  test("path-traversal slug throws at boot", () => {
    expect(() => makeSink({ repoSlug: "../../etc" })).toThrow(/repoSlug/)
    expect(() => makeSink({ repoSlug: "o/r/../../x" })).toThrow(/repoSlug/)
  })

  test("slug with extra path segment throws at boot", () => {
    expect(() => makeSink({ repoSlug: "o/r/pulls/1" })).toThrow(/repoSlug/)
  })

  test("slug missing the owner/repo separator throws at boot", () => {
    expect(() => makeSink({ repoSlug: "justone" })).toThrow(/repoSlug/)
    expect(() => makeSink({ repoSlug: "" })).toThrow(/repoSlug/)
  })

  test("non-integer / non-positive prNumber throws at boot", () => {
    expect(() => makeSink({ prNumber: 0 })).toThrow(/prNumber/)
    expect(() => makeSink({ prNumber: -1 })).toThrow(/prNumber/)
    expect(() => makeSink({ prNumber: 1.5 })).toThrow(/prNumber/)
    expect(() => makeSink({ prNumber: Number.NaN })).toThrow(/prNumber/)
  })

  test("prNumber that smuggles a query string throws at boot", () => {
    // `Number`-typed at the type level, but a hostile composition root could
    // pass through an unchecked value; the gate is the fail-closed backstop.
    expect(() => makeSink({ prNumber: "1/comments?x=" as unknown as number })).toThrow(/prNumber/)
  })

  test("a refused sink never reaches the gh port (no network call)", () => {
    const gh = goodGh()
    expect(() =>
      createPrOutputSink({
        ghCliPort: gh.port,
        repoCwd: "/r",
        repoSlug: "evil/repo/comments?x=",
        prNumber: 1,
        redactPort: identityRedact,
      }),
    ).toThrow(/repoSlug/)
    expect(gh.calls.length).toBe(0)
  })

  test("a validly-constructed sink still posts (gate does not break happy path)", async () => {
    const gh = goodGh()
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "octo/demo",
      prNumber: 7,
      redactPort: identityRedact,
    })
    const res = await sink.postComment({ body: "hello", key })
    expect(res.ok).toBe(true)
    const post = gh.calls.find((c) => c.args.includes("POST"))
    expect(post?.args.some((a) => a.includes("repos/octo/demo/issues/7/comments"))).toBe(true)
  })
})

/**
 * ADR-0311 hellgate — single bot-gate SoT (audit T12-github fix b).
 *
 * The actions source delegated the bot gate to `filter.evaluate`, then
 * REDUNDANTLY re-read `opts.allowBots` in `shouldEmit`. Because an INJECTED
 * `mentionFilter` is built independently of `opts.allowBots`, a caller that
 * passed a filter with `allowBots: true` (deliberately accepting bots) was
 * silently overridden by the default `opts.allowBots !== true` re-check — the
 * Bot event was dropped against the filter's intent. The fix removes the
 * redundant re-check so the injected filter is the sole bot-gate authority,
 * mirroring the webhook-server sibling.
 */
const botEventJson = JSON.stringify({
  action: "created",
  repository: { owner: { login: "octo" }, name: "demo" },
  sender: { login: "dependabot[bot]", type: "Bot" },
  issue: { number: 9, pull_request: {} },
  comment: { body: "@quanta please review", author_association: "COLLABORATOR" },
})

const botEnv = envFromMap({
  QUANTA_GH_ACTIONS_TRIGGER: "1",
  GITHUB_EVENT_PATH: "/bot.json",
  GITHUB_EVENT_NAME: "issue_comment",
  GITHUB_DELIVERY: "deliv-bot",
})

describe("ADR-0311 hellgate — injected filter is the single bot-gate SoT", () => {
  test("injected filter with allowBots:true accepts a Bot sender (no opts.allowBots override)", async () => {
    const fs = fakeFs({ "/bot.json": botEventJson })
    // Caller deliberately opts a trusted bot in via the filter. `opts.allowBots`
    // is intentionally LEFT UNSET (defaults to false) — the old re-check would
    // have dropped this event despite the filter's explicit allow.
    const filter = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "public",
      allowBots: true,
    })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: botEnv,
      clockPort: fixedClock(0),
      mentionFilter: filter,
    })
    const out = await src.poll()
    expect(out.length).toBe(1)
    expect(out[0]?.reason).toBe("pr_comment")
  })

  test("injected filter with allowBots:false still rejects a Bot sender (gate intact)", async () => {
    const fs = fakeFs({ "/bot.json": botEventJson })
    const filter = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "public",
      allowBots: false,
    })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: botEnv,
      clockPort: fixedClock(0),
      mentionFilter: filter,
    })
    expect(await src.poll()).toEqual([])
  })

  test("default-built filter (no allowBots) rejects a Bot sender", async () => {
    const fs = fakeFs({ "/bot.json": botEventJson })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: botEnv,
      clockPort: fixedClock(0),
      // no mentionFilter, no allowBots ⇒ default allowBots:false in the built filter
      triggerPhrases: ["@quanta"],
      requireTrustScope: "public",
    })
    expect(await src.poll()).toEqual([])
  })
})
