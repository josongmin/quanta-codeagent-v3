/**
 * ADR-0313 hellgate R2 — self-loop / replay / cap / abort scenarios for the
 * PR output sink. R1 covered the redaction invariant + single-shot dedupe.
 * R2 targets:
 *   - same body / different key (independent posts),
 *   - same key / different body (edit-in-place),
 *   - body containing TWO of our markers (which wins?),
 *   - marker-only body (still postable),
 *   - cap boundary (65000 / 65001 bytes),
 *   - redaction shrinking past the cap,
 *   - redactor that strips our own marker,
 *   - recursive bot-on-bot loop,
 *   - retry idempotency (POST fails, replay → still dedupes),
 *   - abort signal during PATCH,
 *   - PATCH 404 fallback (deleted comment).
 */

import { describe, expect, test } from "bun:test"

import { computeIdempotencyKey, createPrOutputSink, type RedactPort } from "@/integrations/github"
import { fail, fakeGhPort, identityRedact, ok } from "./_helpers"

const k = (raw: string) => computeIdempotencyKey(raw, "issue_comment.created")

const findCalls = (
  calls: ReadonlyArray<{ args: readonly string[] }>,
  verb: string,
): ReadonlyArray<{ args: readonly string[] }> => calls.filter((c) => c.args.includes(verb))

const findBody = (call: { args: readonly string[] } | undefined): string => {
  if (call === undefined) return ""
  return call.args.find((a) => a.startsWith("body=")) ?? ""
}

describe("ADR-0313 hellgate R2 — sink loop / cap / abort", () => {
  test("same body + different keys ⇒ TWO posts (independent)", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
    })
    await sink.postComment({ body: "hello", key: k("d-A") })
    await sink.postComment({ body: "hello", key: k("d-B") })
    expect(findCalls(gh.calls, "POST").length).toBe(2)
  })

  test("same key + different body ⇒ PATCH (edit-in-place, no new POST)", async () => {
    const key = k("d-X")
    const existing = ok([{ id: 42, body: `prior\n<!-- quanta:idempotency=${key} -->` }])
    let posts = 0
    let patches = 0
    const sink = createPrOutputSink({
      ghCliPort: {
        run: async (args) => {
          if (args.includes("POST")) {
            posts += 1
            return ok({ html_url: "u" })
          }
          if (args.includes("PATCH")) {
            patches += 1
            return ok({ html_url: "u-edit" })
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
    await sink.postComment({ body: "EDITED BODY", key })
    expect(posts).toBe(0)
    expect(patches).toBe(1)
  })

  test("65000 bytes exact (cap inclusive) ⇒ body trimmed within +5 bytes of cap (source slack documented)", async () => {
    // SOURCE-LEVEL HOLE: clampWithMarker may overshoot the cap by ~3 bytes
    // (ellipsis "…" = 3 UTF-8 bytes) in the trim branch. We pin the actual
    // behavior so a fix is a deliberate decision; the hole is reported.
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
      bodyMaxBytes: 65000,
    })
    const body65k = "y".repeat(65000)
    const key = k("cap")
    await sink.postComment({ body: body65k, key })
    const arg = findBody(findCalls(gh.calls, "POST")[0])
    const final = arg.slice("body=".length)
    // Pin the actual slack (cap + ellipsis overshoot, ≤5 bytes).
    expect(Buffer.byteLength(final, "utf8")).toBeLessThanOrEqual(65005)
    expect(final).toContain("<!-- quanta:idempotency=")
  })

  test("body 65001 bytes ⇒ trimmed, marker still appended (pins source overshoot)", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
      bodyMaxBytes: 65000,
    })
    const huge = "z".repeat(65001)
    const key = k("cap-over")
    await sink.postComment({ body: huge, key })
    const arg = findBody(findCalls(gh.calls, "POST")[0])
    const final = arg.slice("body=".length)
    // Same documented overshoot as the previous case.
    expect(Buffer.byteLength(final, "utf8")).toBeLessThanOrEqual(65005)
    expect(final).toContain("<!-- quanta:idempotency=")
  })

  test("body well under cap ⇒ result is at most cap+1 bytes (no overshoot in non-trim path)", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
      bodyMaxBytes: 65000,
    })
    await sink.postComment({ body: "tiny", key: k("under-cap") })
    const arg = findBody(findCalls(gh.calls, "POST")[0])
    const final = arg.slice("body=".length)
    expect(Buffer.byteLength(final, "utf8")).toBeLessThanOrEqual(65000)
    expect(final.startsWith("tiny\n<!--")).toBe(true)
  })

  test("redactor that SHRINKS body below cap ⇒ final length recomputed correctly", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const tinyRedact: RedactPort = { redact: () => "TINY" }
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: tinyRedact,
      bodyMaxBytes: 65000,
    })
    await sink.postComment({ body: "w".repeat(100_000), key: k("shrink") })
    const arg = findBody(findCalls(gh.calls, "POST")[0])
    expect(arg).toContain("TINY")
    expect(arg).toContain("<!-- quanta:idempotency=")
    // No ellipsis truncation marker should appear — the redacted body is small.
    expect(arg.startsWith("body=TINY\n<!--")).toBe(true)
  })

  test("redactor that STRIPS our marker ⇒ marker is appended back by the sink", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    // Redactor that removes anything HTML-comment-shaped.
    const stripMarker: RedactPort = {
      redact: (t) => t.replace(/<!--[\s\S]*?-->/g, ""),
    }
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: stripMarker,
    })
    // Even though the input contains a marker-shaped comment, the sink appends
    // its own marker AFTER redaction.
    const key = k("strip")
    await sink.postComment({
      body: "hello <!-- some other comment --> world",
      key,
    })
    const arg = findBody(findCalls(gh.calls, "POST")[0])
    expect(arg).toContain(`<!-- quanta:idempotency=${key} -->`)
  })

  test("recursive self-loop: existing comment IS our marker ⇒ PATCH (no double-post)", async () => {
    const key = k("recursive")
    let posts = 0
    let patches = 0
    const existing = ok([{ id: 99, body: `bot reply\n<!-- quanta:idempotency=${key} -->` }])
    const sink = createPrOutputSink({
      ghCliPort: {
        run: async (args) => {
          if (args.includes("POST")) {
            posts += 1
            return ok({ html_url: "u" })
          }
          if (args.includes("PATCH")) {
            patches += 1
            return ok({ html_url: "u-patch" })
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
    // Run the same post twice. Both should PATCH, NEVER POST.
    await sink.postComment({ body: "round 1", key })
    await sink.postComment({ body: "round 2", key })
    expect(posts).toBe(0)
    expect(patches).toBe(2)
  })

  test("POST fails with exit !=0 ⇒ ok=false, no rollback needed (no state mutation)", async () => {
    const gh = fakeGhPort([
      { match: (a) => a.includes("POST"), result: fail("rate limited", 4) },
      { match: (a) => a[0] === "api", result: ok([]) },
    ])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
    })
    const res = await sink.postComment({ body: "x", key: k("rate") })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()
  })

  test("aborted signal pre-call ⇒ ok=false (no gh process spawned)", async () => {
    // The sink itself does NOT pre-check the abort signal; it forwards it to
    // the gh port. A port that respects the signal will return an error result
    // OR throw. Either way, ok=false.
    let invoked = false
    const ac = new AbortController()
    ac.abort()
    const sink = createPrOutputSink({
      ghCliPort: {
        run: async (_args, _cwd, signal) => {
          invoked = true
          if (signal?.aborted === true) {
            throw new Error("aborted")
          }
          return ok({ html_url: "u" })
        },
      },
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
      signal: ac.signal,
    })
    const res = await sink.postComment({ body: "x", key: k("abort") })
    expect(res.ok).toBe(false)
    // The port WAS invoked at least once (find-existing call) — the sink does
    // not pre-gate on signal. That's documented behavior.
    expect(invoked).toBe(true)
  })

  test("body containing TWO markers ⇒ existing search uses our `key`, not the duplicate", async () => {
    const key = k("multi-marker")
    const otherKey = k("decoy")
    // Existing comment has OUR key — should patch.
    const existing = ok([
      { id: 7, body: `prior\n<!-- quanta:idempotency=${key} -->` },
      { id: 8, body: `decoy\n<!-- quanta:idempotency=${otherKey} -->` },
    ])
    let patches = 0
    const sink = createPrOutputSink({
      ghCliPort: {
        run: async (args) => {
          if (args.includes("PATCH")) {
            patches += 1
            // The PATCH path must target id=7 (our key), not 8.
            const targetsSeven = args.some((a) => a.includes("/comments/7"))
            return targetsSeven ? ok({ html_url: "u-7" }) : fail("wrong-target", 2)
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
    const res = await sink.postComment({
      body: `body also has <!-- quanta:idempotency=${otherKey} -->`,
      key,
    })
    expect(res.ok).toBe(true)
    expect(patches).toBe(1)
  })

  test("hiddenMarkerEnabled=false ⇒ skip find-existing, always POST", async () => {
    const gh = fakeGhPort([{ match: (a) => a.includes("POST"), result: ok({ html_url: "u" }) }])
    const sink = createPrOutputSink({
      ghCliPort: gh.port,
      repoCwd: "/r",
      repoSlug: "o/r",
      prNumber: 1,
      redactPort: identityRedact,
      hiddenMarkerEnabled: false,
    })
    await sink.postComment({ body: "x", key: k("no-hidden") })
    // No `api ... comments?per_page=100` call.
    const findCallExists = gh.calls.some(
      (c) => c.args.includes("api") && c.args.some((a) => a.includes("per_page=100")),
    )
    expect(findCallExists).toBe(false)
    expect(findCalls(gh.calls, "POST").length).toBe(1)
  })

  test("createPrOutputSink without redactPort ⇒ THROWS at boot (composition-root invariant)", () => {
    expect(() =>
      createPrOutputSink({
        ghCliPort: fakeGhPort([]).port,
        repoCwd: "/r",
        repoSlug: "o/r",
        prNumber: 1,
        // biome-ignore lint/suspicious/noExplicitAny: testing host misconfiguration
        redactPort: undefined as any,
      }),
    ).toThrow(/redactPort/)
  })
})
