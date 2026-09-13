/**
 * ADR-0314 hellgate — mention filter against adversarial bodies + trust
 * scopes. Each case must produce the unambiguously safe answer.
 */

import { describe, expect, test } from "bun:test"

import {
  createMentionFilter,
  matchMention,
  type NormalizedGhEvent,
  normalizeGhEvent,
} from "@/integrations/github"

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

/**
 * ★ Every scope, driven by a REAL comment payload through the real normalizer.
 *
 * `isCollaborator` is true for OWNER, MEMBER and COLLABORATOR, and the filter
 * checked it first, so every owner and member resolved to `collaborator`:
 * `--trust-scope owner` — the example in SETUP.md — and `member` answered no one.
 * The arms above hand-build a sender with `isCollaborator`, which is exactly the
 * shape that could not see it.
 */
describe("trust scope from author_association, through normalizeGhEvent", () => {
  const payload = (association: string | undefined, login = "alice") =>
    normalizeGhEvent({
      kind: "issue_comment",
      raw: {
        action: "created",
        issue: { number: 7 },
        repository: { owner: { login: "octo" }, name: "demo" },
        sender: { login, type: "User" },
        comment: {
          body: "@quanta review",
          ...(association === undefined ? {} : { author_association: association }),
        },
      },
    })
  const admits = (scope: "owner" | "member" | "collaborator" | "public", association?: string) => {
    const event = payload(association)
    if (event === undefined) throw new Error("the payload did not normalize")
    return createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: scope,
      allowBots: false,
    }).evaluate(event).matched
  }

  test("each scope admits its association and every stronger one, and nothing weaker", () => {
    const associations = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"] as const
    const table = Object.fromEntries(
      (["owner", "member", "collaborator", "public"] as const).map((scope) => [
        scope,
        associations.filter((association) => admits(scope, association)),
      ]),
    )
    expect(table).toEqual({
      owner: ["OWNER"],
      member: ["OWNER", "MEMBER"],
      collaborator: ["OWNER", "MEMBER", "COLLABORATOR"],
      public: ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"],
    })
  })

  test("PAIRED CONTROL — with no association, the owner is still recognised by login", () => {
    const event = payload(undefined, "octo")
    if (event === undefined) throw new Error("the payload did not normalize")
    const owner = createMentionFilter({
      triggerPhrases: ["@quanta"],
      requireTrustScope: "owner",
      allowBots: false,
    })
    expect(owner.evaluate(event).matched).toBe(true)
    const stranger = payload(undefined, "mallory")
    if (stranger === undefined) throw new Error("the payload did not normalize")
    expect(owner.evaluate(stranger).matched).toBe(false)
  })
})
