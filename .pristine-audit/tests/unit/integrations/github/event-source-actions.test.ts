/**
 * ADR-0311 — createActionsEventSource happy + default-OFF + idempotent emit.
 */

import { describe, expect, test } from "bun:test"

import { createActionsEventSource, createDeliveryStore } from "@/integrations/github"

import { envFromMap, fakeFs, fixedClock } from "./_helpers"

const eventJson = JSON.stringify({
  action: "created",
  repository: { owner: { login: "octo" }, name: "demo" },
  sender: { login: "alice", type: "User" },
  issue: { number: 7, pull_request: {} },
  comment: { body: "@quanta review please", author_association: "COLLABORATOR" },
})

describe("ADR-0311 — createActionsEventSource", () => {
  test("default-OFF: env unset ⇒ empty", async () => {
    const fs = fakeFs({ "/e.json": eventJson })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({}),
      clockPort: fixedClock(0),
    })
    expect(await src.poll()).toEqual([])
  })

  test("happy path: env on + collaborator mention ⇒ trigger", async () => {
    const fs = fakeFs({ "/e.json": eventJson })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/e.json",
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_DELIVERY: "deliv-1",
      }),
      clockPort: fixedClock(0),
    })
    const out = await src.poll()
    expect(out.length).toBe(1)
    const t = out[0]
    if (t === undefined) throw new Error("unreachable")
    expect(t.reason).toBe("pr_comment")
    expect(t.evidence.kind).toBe("url")
    expect(t.evidence.value).toBe("https://github.com/octo/demo/pull/7")
    expect(t.simulatedMessage).toContain("@alice")
    expect(t.simulatedMessage).toContain("#7")
  })

  test("same delivery id ⇒ emits only once across polls", async () => {
    const fs = fakeFs({ "/e.json": eventJson })
    const store = createDeliveryStore()
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/e.json",
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_DELIVERY: "deliv-1",
      }),
      clockPort: fixedClock(0),
      deliveryStore: store,
    })
    expect((await src.poll()).length).toBe(1)
    expect(await src.poll()).toEqual([])
  })

  test("workflow_dispatch fires manual_resume reason without mention", async () => {
    const fs = fakeFs({
      "/d.json": JSON.stringify({
        action: "requested",
        repository: { owner: { login: "o" }, name: "r" },
        sender: { login: "u", type: "User" },
        inputs: {},
      }),
    })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/d.json",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_DELIVERY: "deliv-2",
      }),
      clockPort: fixedClock(0),
    })
    const out = await src.poll()
    expect(out.length).toBe(1)
    expect(out[0]?.reason).toBe("manual_resume")
  })

  test("non-collaborator sender ⇒ no trigger", async () => {
    const fs = fakeFs({
      "/e.json": JSON.stringify({
        action: "created",
        repository: { owner: { login: "o" }, name: "r" },
        sender: { login: "stranger", type: "User" },
        issue: { number: 1, pull_request: {} },
        comment: { body: "@quanta hi", author_association: "NONE" },
      }),
    })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/e.json",
        GITHUB_EVENT_NAME: "issue_comment",
      }),
      clockPort: fixedClock(0),
    })
    expect(await src.poll()).toEqual([])
  })

  test("bot sender (sender.type=Bot) ⇒ no trigger", async () => {
    const fs = fakeFs({
      "/e.json": JSON.stringify({
        action: "created",
        repository: { owner: { login: "o" }, name: "r" },
        sender: { login: "bot[bot]", type: "Bot" },
        issue: { number: 1, pull_request: {} },
        comment: { body: "@quanta hi", author_association: "COLLABORATOR" },
      }),
    })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/e.json",
        GITHUB_EVENT_NAME: "issue_comment",
      }),
      clockPort: fixedClock(0),
    })
    expect(await src.poll()).toEqual([])
  })

  test("aborted signal short-circuits poll", async () => {
    const fs = fakeFs({ "/e.json": eventJson })
    const src = createActionsEventSource({
      fsPort: fs,
      envPort: envFromMap({
        QUANTA_GH_ACTIONS_TRIGGER: "1",
        GITHUB_EVENT_PATH: "/e.json",
        GITHUB_EVENT_NAME: "issue_comment",
      }),
      clockPort: fixedClock(0),
    })
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await src.poll({ signal: ctrl.signal })).toEqual([])
  })
})
