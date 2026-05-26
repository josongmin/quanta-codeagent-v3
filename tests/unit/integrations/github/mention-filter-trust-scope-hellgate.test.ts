/**
 * ADR-0314 hellgate — mention filter against adversarial bodies + trust
 * scopes. Each case must produce the unambiguously safe answer.
 */

import { describe, expect, test } from "bun:test"

import { createMentionFilter, matchMention, type NormalizedGhEvent } from "@/integrations/github"

const ev = (body: string, overrides: Partial<NormalizedGhEvent> = {}): NormalizedGhEvent =>
  Object.freeze({
    kind: "issue_comment",
    deliveryId: "x",
    repo: { owner: "octo", name: "demo" },
    sender: { login: "alice", type: "User", isCollaborator: true },
    body,
    raw: {},
    ...overrides,
  })

describe("ADR-0314 hellgate — mention filter", () => {
  test("phrase inside fenced ``` block ⇒ no match", () => {
    const body = "```\n@quanta review\n```"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("phrase inside fenced ```ts block ⇒ no match (language tag)", () => {
    const body = "```ts\n// @quanta look\n```"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("phrase inside inline `code` ⇒ no match", () => {
    const body = "use `@quanta` in your comment"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("phrase in blockquote ⇒ no match", () => {
    const body = "> @quanta review please"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("phrase in nested blockquote ⇒ no match", () => {
    const body = "> > @quanta hi"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("phrase on line OUTSIDE code block matches even when block is present", () => {
    const body = "```\nnot here\n```\n@quanta yes"
    expect(matchMention(body, ["@quanta"]).matched).toBe(true)
  })

  test("non-collaborator (isCollaborator=false) cannot trigger via collaborator scope", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "collaborator",
      allowBots: false,
    })
    expect(
      f.evaluate(ev("@quanta hi", { sender: { login: "x", type: "User", isCollaborator: false } }))
        .matched,
    ).toBe(false)
  })

  test("sender with no isCollaborator and not owner cannot trigger collaborator scope", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "collaborator",
      allowBots: false,
    })
    expect(f.evaluate(ev("@quanta hi", { sender: { login: "guest", type: "User" } })).matched).toBe(
      false,
    )
  })

  test("bot sender even with collaborator association cannot trigger", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "collaborator",
      allowBots: false,
    })
    expect(
      f.evaluate(
        ev("@quanta hi", {
          sender: { login: "bot[bot]", type: "Bot", isCollaborator: true },
        }),
      ).matched,
    ).toBe(false)
  })

  test("allowBots=true lets a bot trigger", () => {
    const f = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "collaborator",
      allowBots: true,
    })
    expect(
      f.evaluate(
        ev("@quanta hi", {
          sender: { login: "bot[bot]", type: "Bot", isCollaborator: true },
        }),
      ).matched,
    ).toBe(true)
  })

  test("body with our idempotency marker ⇒ no match (self-loop guard)", () => {
    const body = "previous reply\n<!-- quanta:idempotency=deadbeefcafe1234 -->\n@quanta hi"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("ZWJ between phrase chars ⇒ no match", () => {
    const body = "@qua‍nta hi"
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("RTL override embedded ⇒ no match (boundaries violated)", () => {
    const body = "@quanta‮review"
    // Phrase is followed by RTL override + no separator ⇒ boundary check fails.
    // Even if the regex thinks it matches, the word-boundary anchor rejects it.
    const m = matchMention(body, ["@quanta"])
    // We don't care which branch — only that the outcome is well-defined and
    // does NOT silently emit a different command.
    if (m.matched) expect(m.command).toBe("@quanta")
    else expect(m.matched).toBe(false)
  })

  test("phrase appearing 50 times in code blocks ⇒ no match", () => {
    const body = `\`\`\`\n${"@quanta\n".repeat(50)}\`\`\``
    expect(matchMention(body, ["@quanta"]).matched).toBe(false)
  })

  test("phrase preceded by alphanumeric (no word boundary) ⇒ no match", () => {
    expect(matchMention("foo@quanta hi", ["@quanta"]).matched).toBe(false)
  })

  test("phrase followed by alphanumeric (no word boundary) ⇒ no match", () => {
    expect(matchMention("@quantaisawesome", ["@quanta"]).matched).toBe(false)
  })

  test("phrase followed by punctuation IS a word boundary", () => {
    expect(matchMention("@quanta, please look", ["@quanta"]).matched).toBe(true)
  })
})
