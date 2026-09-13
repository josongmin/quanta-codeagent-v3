/**
 * ADR-0311 — parseGhEventFile + normalizeGhEvent happy paths.
 */

import { describe, expect, test } from "bun:test"

import { ALL_GH_EVENT_KINDS, normalizeGhEvent, parseGhEventFile } from "@/integrations/github"

import { fakeFs } from "./_helpers"

const samplePayload = {
  action: "created",
  repository: { owner: { login: "octo" }, name: "demo" },
  sender: { login: "alice", type: "User" },
  issue: { number: 7, pull_request: {} },
  comment: { body: "@quanta review please", author_association: "COLLABORATOR" },
}

describe("ADR-0311 — parseGhEventFile", () => {
  test("happy: reads file and JSON-parses", async () => {
    const fs = fakeFs({ "/event.json": JSON.stringify(samplePayload) })
    const raw = await parseGhEventFile({ fsPort: fs, path: "/event.json" })
    expect(raw).toBeDefined()
    expect((raw as { action?: string }).action).toBe("created")
  })

  test("missing file ⇒ undefined", async () => {
    const fs = fakeFs({})
    expect(await parseGhEventFile({ fsPort: fs, path: "/missing.json" })).toBeUndefined()
  })

  test("malformed JSON ⇒ undefined", async () => {
    const fs = fakeFs({ "/bad.json": "{ this is not json" })
    expect(await parseGhEventFile({ fsPort: fs, path: "/bad.json" })).toBeUndefined()
  })

  test("oversize file ⇒ undefined (10MB default cap)", async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, "{")
    const fs = fakeFs({ "/huge.json": huge })
    expect(await parseGhEventFile({ fsPort: fs, path: "/huge.json" })).toBeUndefined()
  })

  test("file with null bytes ⇒ undefined", async () => {
    const fs = fakeFs({ "/nul.json": Buffer.from("{\x00}", "utf8") })
    expect(await parseGhEventFile({ fsPort: fs, path: "/nul.json" })).toBeUndefined()
  })

  test("UTF-8 BOM is stripped", async () => {
    const bomBuf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        '{"action":"x","repository":{"owner":{"login":"o"},"name":"r"},"sender":{"login":"u","type":"User"}}',
        "utf8",
      ),
    ])
    const fs = fakeFs({ "/bom.json": bomBuf })
    const raw = await parseGhEventFile({ fsPort: fs, path: "/bom.json" })
    expect(raw).toBeDefined()
    expect((raw as { action?: string }).action).toBe("x")
  })
})

describe("ADR-0311 — normalizeGhEvent", () => {
  test("normalizes issue_comment payload with PR anchor", () => {
    const ev = normalizeGhEvent({ raw: samplePayload, kind: "issue_comment" })
    expect(ev).toBeDefined()
    if (ev === undefined) throw new Error("unreachable")
    expect(ev.repo).toEqual({ owner: "octo", name: "demo" })
    expect(ev.prNumber).toBe(7)
    expect(ev.body).toBe("@quanta review please")
    expect(ev.sender).toEqual({
      login: "alice",
      type: "User",
      isCollaborator: true,
      // Kept verbatim: the trust scope reads it, and the boolean alone made
      // OWNER and MEMBER indistinguishable from COLLABORATOR.
      association: "COLLABORATOR",
    })
  })

  test("deliveryId override is honored", () => {
    const ev = normalizeGhEvent({
      raw: samplePayload,
      kind: "issue_comment",
      deliveryId: "delivery-abc",
    })
    expect(ev?.deliveryId).toBe("delivery-abc")
  })

  test("missing repo ⇒ undefined", () => {
    const ev = normalizeGhEvent({ raw: { action: "x" }, kind: "issues" })
    expect(ev).toBeUndefined()
  })

  test("unknown sender.type collapses to User", () => {
    const ev = normalizeGhEvent({
      raw: {
        ...samplePayload,
        sender: { login: "bob", type: "NotARealType" },
      },
      kind: "issue_comment",
    })
    expect(ev?.sender.type).toBe("User")
  })

  test("workflow_dispatch carries inputs as JSON body", () => {
    const ev = normalizeGhEvent({
      raw: {
        action: "requested",
        repository: { owner: { login: "o" }, name: "r" },
        sender: { login: "u", type: "User" },
        inputs: { task: "review" },
      },
      kind: "workflow_dispatch",
    })
    expect(ev?.body).toBe(JSON.stringify({ task: "review" }))
  })

  test("ALL_GH_EVENT_KINDS includes the six documented kinds", () => {
    expect(ALL_GH_EVENT_KINDS).toEqual([
      "issue_comment",
      "pull_request_review_comment",
      "pull_request_review",
      "pull_request",
      "issues",
      "workflow_dispatch",
    ])
  })
})
