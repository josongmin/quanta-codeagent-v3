/**
 * RFC-12-2 — parser hellgate for the three richer `@`-mention sources
 * (`@mcp:<name>` / `@subagent:<name>` / `@thread:<id>`). Proves the dedicated
 * colon-literal alternatives classify + span correctly, require the `:payload`
 * suffix (bare form ⇒ skill), honour left/right boundaries, dedup, cap length,
 * and leave the legacy `@git` / kebab cascade untouched.
 */

import { describe, expect, test } from "bun:test"
import { parseMentions } from "../parser"

describe("parseMentions — RFC-12-2 mcp / subagent / thread", () => {
  test("R1 — @mcp:<name> classifies as mcp with the name target", () => {
    const out = parseMentions("use @mcp:github now")
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: "mcp", target: "github", raw: "@mcp:github" })
  })

  test("R2 — @subagent:<name> classifies as subagent", () => {
    const out = parseMentions("spawn @subagent:explorer here")
    expect(out[0]).toMatchObject({
      kind: "subagent",
      target: "explorer",
      raw: "@subagent:explorer",
    })
  })

  test("R3 — @thread:<uuid> classifies as thread (dashes allowed in id)", () => {
    const id = "9f8e7d6c-1234-4abc-9def-0123456789ab"
    const out = parseMentions(`recall @thread:${id} tail`)
    expect(out[0]).toMatchObject({ kind: "thread", target: id, raw: `@thread:${id}` })
  })

  test("R4 — BARE @mcp / @subagent / @thread (no :payload) fall through to skill", () => {
    // Unlike @git (which reserves the bare literal), these three require the
    // colon payload, so a bare form stays a reachable kebab skill.
    expect(parseMentions("bare @mcp x")[0]).toMatchObject({ kind: "skill", target: "mcp" })
    expect(parseMentions("@subagent alone")[0]).toMatchObject({ kind: "skill", target: "subagent" })
    expect(parseMentions("@thread here")[0]).toMatchObject({ kind: "skill", target: "thread" })
    // and @mcp: with an EMPTY payload also degrades to the bare skill.
    expect(parseMentions("@mcp: empty")[0]).toMatchObject({ kind: "skill", target: "mcp" })
  })

  test("R5 — left-boundary: an @mcp glued to a word char is NOT a mention", () => {
    expect(parseMentions("foo@mcp:x")).toEqual([])
  })

  test("R6 — right-boundary: the payload stops at the first non-alphabet char", () => {
    // '/' is not in the [A-Za-z0-9_-] payload alphabet ⇒ payload = "a".
    const out = parseMentions("@mcp:a/b")
    expect(out[0]).toMatchObject({ kind: "mcp", target: "a", raw: "@mcp:a" })
  })

  test("R7 — span offsets match the raw match exactly", () => {
    const out = parseMentions("hi @subagent:qa")
    expect(out[0]?.span).toEqual({ start: 3, end: 3 + "@subagent:qa".length })
  })

  test("R8 — dedup by (kind,target); cross-kind same-name targets do NOT collide", () => {
    const out = parseMentions("@mcp:x @mcp:x @subagent:x")
    expect(out.map((m) => `${m.kind}:${m.target}`)).toEqual(["mcp:x", "subagent:x"])
  })

  test("R9 — over-long payload (>128) is rejected (no mention)", () => {
    const long = "a".repeat(129)
    expect(parseMentions(`@thread:${long}`)).toEqual([])
  })

  test("R10 — legacy @git:diff still parses as git (RFC-12-2 alts do not shadow it)", () => {
    expect(parseMentions("@git:diff")[0]).toMatchObject({ kind: "git", target: "diff" })
  })
})
