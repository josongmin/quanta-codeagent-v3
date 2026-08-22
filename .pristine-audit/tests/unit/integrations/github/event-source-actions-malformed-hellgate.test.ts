/**
 * ADR-0311 hellgate — `createActionsEventSource` against hostile event-file
 * inputs. Every adversarial case MUST collapse to `[]` (boundary contract).
 */

import { describe, expect, test } from "bun:test"

import { createActionsEventSource } from "@/integrations/github"

import { envFromMap, fakeFs, fixedClock } from "./_helpers"

const baseEnv = {
  QUANTA_GH_ACTIONS_TRIGGER: "1",
  GITHUB_EVENT_PATH: "/e.json",
  GITHUB_EVENT_NAME: "issue_comment",
  GITHUB_DELIVERY: "h-1",
}

const sourceWithFile = (file: string | Buffer, env: Record<string, string | undefined> = baseEnv) =>
  createActionsEventSource({
    fsPort: fakeFs({ "/e.json": file }),
    envPort: envFromMap(env),
    clockPort: fixedClock(0),
  })

describe("ADR-0311 hellgate — malformed event payloads", () => {
  test("file not present ⇒ empty", async () => {
    const src = createActionsEventSource({
      fsPort: fakeFs({}),
      envPort: envFromMap(baseEnv),
      clockPort: fixedClock(0),
    })
    expect(await src.poll()).toEqual([])
  })

  test("empty file ⇒ empty", async () => {
    expect(await sourceWithFile("").poll()).toEqual([])
  })

  test("JSON array root (not object) ⇒ empty", async () => {
    expect(await sourceWithFile("[1,2,3]").poll()).toEqual([])
  })

  test("JSON null root ⇒ empty", async () => {
    expect(await sourceWithFile("null").poll()).toEqual([])
  })

  test("100MB payload (above 10MB cap) ⇒ empty", async () => {
    const huge = Buffer.alloc(100 * 1024 * 1024, "{")
    expect(await sourceWithFile(huge).poll()).toEqual([])
  })

  test("payload with embedded NUL byte ⇒ empty", async () => {
    const corrupted = Buffer.concat([
      Buffer.from('{"action":"x"', "utf8"),
      Buffer.from([0x00]),
      Buffer.from("}", "utf8"),
    ])
    expect(await sourceWithFile(corrupted).poll()).toEqual([])
  })

  test("missing repository ⇒ empty", async () => {
    const body = JSON.stringify({
      action: "created",
      sender: { login: "alice", type: "User" },
      issue: { number: 1, pull_request: {} },
      comment: { body: "@quanta hi", author_association: "COLLABORATOR" },
    })
    expect(await sourceWithFile(body).poll()).toEqual([])
  })

  test("missing comment body ⇒ no mention ⇒ empty", async () => {
    const body = JSON.stringify({
      action: "created",
      repository: { owner: { login: "o" }, name: "r" },
      sender: { login: "alice", type: "User" },
      issue: { number: 1, pull_request: {} },
      comment: { author_association: "COLLABORATOR" },
    })
    expect(await sourceWithFile(body).poll()).toEqual([])
  })

  test("unknown GITHUB_EVENT_NAME ⇒ empty", async () => {
    expect(
      await sourceWithFile("{}", {
        ...baseEnv,
        GITHUB_EVENT_NAME: "unknown_event_kind",
      }).poll(),
    ).toEqual([])
  })

  test("GITHUB_EVENT_NAME absent ⇒ empty", async () => {
    expect(
      await sourceWithFile("{}", {
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/e.json",
      }).poll(),
    ).toEqual([])
  })

  test("GITHUB_EVENT_PATH absent ⇒ empty", async () => {
    expect(
      await sourceWithFile("{}", {
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_NAME: "issue_comment",
      }).poll(),
    ).toEqual([])
  })

  test("deeply nested garbage ⇒ empty", async () => {
    let nested: unknown = 0
    for (let i = 0; i < 1000; i++) nested = { x: nested }
    let json: string
    try {
      json = JSON.stringify({ ...(nested as object), action: "x" })
    } catch {
      json = "{}"
    }
    expect(await sourceWithFile(json).poll()).toEqual([])
  })

  test("UTF-8 BOM tolerated when payload is otherwise valid", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const body = JSON.stringify({
      action: "created",
      repository: { owner: { login: "o" }, name: "r" },
      sender: { login: "alice", type: "User" },
      issue: { number: 3, pull_request: {} },
      comment: { body: "@quanta hi", author_association: "COLLABORATOR" },
    })
    const buf = Buffer.concat([bom, Buffer.from(body, "utf8")])
    const out = await sourceWithFile(buf).poll()
    expect(out.length).toBe(1)
  })
})
