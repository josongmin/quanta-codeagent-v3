/**
 * ADR-0313 hellgate — every outgoing body MUST pass through the redact port.
 * If a secret slips through, the regression surfaces here.
 */

import { describe, expect, test } from "bun:test"

import { computeIdempotencyKey, createPrOutputSink, type RedactPort } from "@/integrations/github"
import { redactSecrets } from "@/security"
import { fakeGhPort, ok } from "./_helpers"

const key = computeIdempotencyKey("h-delivery", "issue_comment")

const redactProd: RedactPort = {
  redact: (t) => redactSecrets(t, { origin: "tool_result" }).text,
}

const findPostBody = (calls: ReadonlyArray<{ args: readonly string[] }>): string | undefined => {
  const post = calls.find((c) => c.args.includes("POST"))
  return post?.args.find((a) => a.startsWith("body="))
}

describe("ADR-0313 hellgate — redaction is mandatory", () => {
  test("AWS access key id in body is redacted", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactProd,
    })
    await sink.postComment({ body: "leak AKIAIOSFODNN7EXAMPLE here", key })
    const body = findPostBody(gh.calls)
    expect(body).toContain("[REDACTED:aws_access_key_id]")
    expect(body).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })

  test("GitHub PAT classic is redacted", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactProd,
    })
    await sink.postComment({
      body: `token=ghp_${"A".repeat(40)}`,
      key,
    })
    const body = findPostBody(gh.calls)
    expect(body).toContain("[REDACTED:github_pat_classic]")
  })

  test("Anthropic API key is redacted", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactProd,
    })
    await sink.postComment({
      body: `key: sk-ant-${"A".repeat(40)}`,
      key,
    })
    const body = findPostBody(gh.calls)
    expect(body).toContain("[REDACTED:anthropic_api_key]")
  })

  test("JWT is redacted", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactProd,
    })
    const jwt = `eyJ${"x".repeat(20)}.eyJ${"y".repeat(20)}.${"z".repeat(20)}`
    await sink.postComment({ body: `auth: ${jwt}`, key })
    const body = findPostBody(gh.calls)
    expect(body).toContain("[REDACTED:jwt]")
  })

  test("PEM private key block is redacted", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactProd,
    })
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEFAA\n-----END PRIVATE KEY-----"
    await sink.postComment({ body: `key:\n${pem}`, key })
    const body = findPostBody(gh.calls)
    expect(body).toContain("[REDACTED:pem_private_key_block]")
  })

  test("idempotency marker is appended after redaction", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactProd,
    })
    await sink.postComment({ body: "clean message", key })
    const body = findPostBody(gh.calls)
    expect(body).toContain("<!-- quanta:idempotency=")
    expect(body).toContain(key)
  })

  test("recursive self-comment is detected via marker (would dedupe)", async () => {
    // If our sink ever read its own prior comment back, the marker prevents
    // double-posting AND the mention filter would not re-trigger on it.
    const existing = ok([{ id: 5, body: `prior reply\n<!-- quanta:idempotency=${key} -->` }])
    let posted = false
    let patched = false
    const sink = createPrOutputSink({
      ghCliPort: {
        run: async (args) => {
          if (args.includes("POST")) {
            posted = true
            return ok({ html_url: "u" })
          }
          if (args.includes("PATCH")) {
            patched = true
            return ok({ html_url: "u-patched" })
          }
          if (args[0] === "api") return existing
          return { stdout: "", stderr: "", exitCode: 1 }
        },
      },
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactProd,
    })
    await sink.postComment({ body: "updated", key })
    expect(posted).toBe(false)
    expect(patched).toBe(true)
  })

  test("over-cap body is trimmed BEFORE the marker", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: redactProd,
      bodyMaxBytes: 256,
    })
    const huge = "X".repeat(10_000)
    await sink.postComment({ body: huge, key })
    const body = findPostBody(gh.calls)
    expect(body).toBeDefined()
    if (body === undefined) throw new Error("unreachable")
    expect(body.length).toBeLessThan("body=".length + 320)
    expect(body).toContain("<!-- quanta:idempotency=")
  })

  test("redact port that throws ⇒ ok=false (no crash)", async () => {
    const gh = fakeGhPort([{ match: (a) => a[0] === "api", result: ok([]) }])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: {
        redact: () => {
          throw new Error("redact crashed")
        },
      },
    })
    // aug-22 audit: this used to be `try { expect(res.ok).toBe(false) } catch
    // { threw = true }` closed by `expect(threw || true).toBe(true)` — a literal
    // tautology, and worse, the `catch` converted the ONLY real assertion's
    // failure into the "threw" branch. A mutation making `prepareBody` swallow
    // the redact error and post the UNMASKED body (the secret-leak bug this file
    // exists to catch) passed 1/0. Both admissible outcomes are now asserted
    // explicitly, and the decisive invariant — nothing was POSTED — is checked
    // against the gh call log rather than inferred.
    const outcome = await sink
      .postComment({ body: "x", key })
      .then((res) => ({ threw: false, ok: res.ok }))
      .catch(() => ({ threw: true, ok: undefined }))
    // Either "threw" or "ok:false" is admissible; "ok:true" is not.
    expect(outcome.threw || outcome.ok === false).toBe(true)
    expect(outcome.ok).not.toBe(true)
    // The load-bearing part: a crashed redact must never reach the wire. Uses
    // this file's own `findPostBody` helper so the check reads the SAME call
    // shape every other test here asserts on (a hand-rolled filter over the
    // wrong element type would silently match nothing — vacuous again).
    expect(findPostBody(gh.calls)).toBeUndefined()
  })
})
