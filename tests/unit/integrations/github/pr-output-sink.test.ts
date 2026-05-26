/**
 * ADR-0313 — createPrOutputSink boot-time invariants + idempotency marker
 * stamping + redaction pass-through.
 */

import { describe, expect, test } from "bun:test"

import { computeIdempotencyKey, createPrOutputSink, type RedactPort } from "@/integrations/github"

import { fail, fakeGhPort, identityRedact, ok } from "./_helpers"

const key = computeIdempotencyKey("delivery-x", "issue_comment.created")

describe("ADR-0313 — boot-time invariants", () => {
  test("missing redactPort throws at create-time", () => {
    expect(() =>
      createPrOutputSink({
        ghCliPort: fakeGhPort([]).port,
        repoCwd: "/r",
        repoSlug: "o/r",
        prNumber: 1,
        // biome-ignore lint/suspicious/noExplicitAny: testing missing port
        redactPort: undefined as any,
      }),
    ).toThrow(/redactPort/)
  })

  test("redact must be a function", () => {
    expect(() =>
      createPrOutputSink({
        ghCliPort: fakeGhPort([]).port,
        repoCwd: "/r",
        repoSlug: "o/r",
        prNumber: 1,
        // biome-ignore lint/suspicious/noExplicitAny: testing bad shape
        redactPort: { redact: "not a fn" } as any,
      }),
    ).toThrow(/redactPort\.redact/)
  })
})

describe("ADR-0313 — postComment", () => {
  test("happy: posts body with idempotency marker + redact pass-through", async () => {
    const gh = fakeGhPort([
      {
        match: (a) => a[0] === "api" && a.includes("--method") && a.includes("POST"),
        result: ok({ html_url: "https://example/c/1" }),
      },
      { match: (a) => a[0] === "api", result: ok([]) }, // existence-check GET
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
    })
    const res = await sink.postComment({ body: "hello", key })
    expect(res.ok).toBe(true)
    expect(res.url).toBe("https://example/c/1")
    const postCall = gh.calls.find((c) => c.args.includes("POST"))
    expect(postCall).toBeDefined()
    // body= argument includes the marker
    const bodyArg = postCall?.args.find((a) => a.startsWith("body="))
    expect(bodyArg).toContain("<!-- quanta:idempotency=")
    expect(bodyArg).toContain(key)
  })

  test("redact port is called and result is used", async () => {
    const redactSeen: string[] = []
    const redact: RedactPort = {
      redact: (t) => {
        redactSeen.push(t)
        return "[redacted]"
      },
    }
    const gh = fakeGhPort([
      { match: (a) => a.includes("--method") && a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redact,
    })
    await sink.postComment({ body: "secret AKIA000000000000ABCD", key })
    expect(redactSeen.length).toBe(1)
    const postCall = gh.calls.find((c) => c.args.includes("POST"))
    const bodyArg = postCall?.args.find((a) => a.startsWith("body="))
    expect(bodyArg).toContain("[redacted]")
    expect(bodyArg).not.toContain("AKIA000")
  })

  test("gh exit non-zero ⇒ ok=false with reason", async () => {
    const gh = fakeGhPort([
      { match: (a) => a[0] === "api" && !a.includes("--method"), result: ok([]) },
      {
        match: (a) => a.includes("--method") && a.includes("POST"),
        result: fail("rate-limited"),
      },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
    })
    const res = await sink.postComment({ body: "x", key })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("gh-exit-1")
  })

  test("existing comment with same key ⇒ PATCH instead of POST", async () => {
    const existing = ok([{ id: 99, body: `prior body\n<!-- quanta:idempotency=${key} -->` }])
    let patched = false
    let posted = false
    const sink = createPrOutputSink({
      ghCliPort: {
        run: async (args) => {
          if (args.includes("PATCH")) {
            patched = true
            return ok({ html_url: "https://example/c/99" })
          }
          if (args.includes("POST")) {
            posted = true
            return ok({ html_url: "x" })
          }
          if (args[0] === "api") return existing
          return fail("nope")
        },
      },
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
    })
    const res = await sink.postComment({ body: "updated body", key })
    expect(res.ok).toBe(true)
    expect(patched).toBe(true)
    expect(posted).toBe(false)
  })

  test("postReview: APPROVE verdict surfaces correct event arg", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "https://example/r/1" }) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
    })
    const res = await sink.postReview({ verdict: "approve", body: "LGTM", key })
    expect(res.ok).toBe(true)
    const eventArg = gh.calls
      .find((c) => c.args.includes("POST"))
      ?.args.find((a) => a.startsWith("event="))
    expect(eventArg).toBe("event=APPROVE")
  })

  test("postReviewComment: includes file + line args", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "https://example/rc/1" }) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
    })
    const res = await sink.postReviewComment({
      file: "src/foo.ts",
      line: 42,
      body: "consider X",
      key,
    })
    expect(res.ok).toBe(true)
    const callArgs = gh.calls.find((c) => c.args.includes("POST"))?.args ?? []
    expect(callArgs).toContain("path=src/foo.ts")
    expect(callArgs).toContain("line=42")
  })
})
