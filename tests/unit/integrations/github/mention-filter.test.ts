/**
 * ADR-0314 — matchMention + createMentionFilter happy paths.
 */

import { describe, expect, test } from "bun:test"

import { createMentionFilter, matchMention, type NormalizedGhEvent } from "@/integrations/github"

const eventWithBody = (body: string, opts: Partial<NormalizedGhEvent> = {}): NormalizedGhEvent =>
  Object.freeze({
    kind: "issue_comment",
    deliveryId: "d1",
    repo: { owner: "octo", name: "demo" },
    sender: { login: "alice", type: "User", isCollaborator: true },
    body,
    raw: {},
    ...opts,
  })

describe("ADR-0314 — matchMention", () => {
  test("plain @quanta matches", () => {
    const m = matchMention("@quanta look at this", ["@quanta"])
    expect(m.matched).toBe(true)
    expect(m.command).toBe("@quanta")
    expect(m.atLine).toBe(1)
  })

  test("/quanta with args is parsed", () => {
    const m = matchMention("/quanta fix the bug in foo.ts", ["/quanta"])
    expect(m.matched).toBe(true)
    expect(m.args).toBe("fix the bug in foo.ts")
  })

  test("case-insensitive", () => {
    expect(matchMention("@QUANTA hi", ["@quanta"]).matched).toBe(true)
  })

  test("no phrase ⇒ no match", () => {
    expect(matchMention("hello there", ["@quanta"]).matched).toBe(false)
  })

  test("empty body / empty phrases ⇒ no match", () => {
    expect(matchMention("", ["@quanta"]).matched).toBe(false)
    expect(matchMention("@quanta", []).matched).toBe(false)
  })

  test("phrase as substring without word boundary ⇒ no match", () => {
    expect(matchMention("foo@quantaxx hi", ["@quanta"]).matched).toBe(false)
  })
})

describe("ADR-0314 — createMentionFilter trust-scope gate", () => {
  test("collaborator passes when requireTrustScope=collaborator", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "collaborator",
      allowBots: false,
    })
    expect(f.evaluate(eventWithBody("@quanta hi")).matched).toBe(true)
  })

  test("non-collaborator (isCollaborator=false) rejected", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "collaborator",
      allowBots: false,
    })
    const ev = eventWithBody("@quanta hi", {
      sender: { login: "stranger", type: "User", isCollaborator: false },
    })
    expect(f.evaluate(ev).matched).toBe(false)
  })

  test("bot sender is rejected by default", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "collaborator",
      allowBots: false,
    })
    const ev = eventWithBody("@quanta hi", {
      sender: { login: "dependabot[bot]", type: "Bot", isCollaborator: true },
    })
    expect(f.evaluate(ev).matched).toBe(false)
  })

  test("public scope opens to anyone", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "public",
      allowBots: false,
    })
    const ev = eventWithBody("@quanta hi", {
      sender: { login: "stranger", type: "User" },
    })
    expect(f.evaluate(ev).matched).toBe(true)
  })

  test("repo owner is trusted even without explicit collaborator flag", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "owner",
      allowBots: false,
    })
    const ev = eventWithBody("@quanta hi", {
      repo: { owner: "alice", name: "demo" },
      sender: { login: "alice", type: "User" },
    })
    expect(f.evaluate(ev).matched).toBe(true)
  })
})
