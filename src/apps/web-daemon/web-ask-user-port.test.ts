import { describe, expect, it } from "bun:test"
import type { UserInputOutcome } from "@/tool"
import type { AskUserRequest } from "@/tool/ask-user"
import { createWebAskUserPort } from "./web-ask-user-port"

/** A fake requester that records the request it was called with and returns a
 *  scripted outcome — lets us assert the DOWN-map (prompt/choices) and the
 *  UP-map (answer → typed value) in one place, no WS/daemon needed. */
const fakeRequester = (outcome: UserInputOutcome) => {
  const seen: { promptId: string; prompt: string; choices?: readonly string[]; multiline?: boolean }[] = []
  const requester = async (req: {
    promptId: string
    prompt: string
    choices?: readonly string[]
    multiline?: boolean
  }): Promise<UserInputOutcome> => {
    seen.push(req)
    return outcome
  }
  return { requester, seen }
}

const answer = (text: string): UserInputOutcome => ({ decision: "answer", text })
const cancelled: UserInputOutcome = { decision: "cancelled" }

describe("createWebAskUserPort — structured ask_user over the request_user_input channel", () => {
  it("select: down-maps options→choices, up-maps chosen label→value", async () => {
    const { requester, seen } = fakeRequester(answer("rebase"))
    const port = createWebAskUserPort(requester, () => "id-1")
    const req: AskUserRequest = {
      kind: "select",
      prompt: "How to integrate?",
      options: ["merge", { label: "rebase", description: "replay commits", preview: "git rebase" }],
    }
    const res = await port.ask(req)
    // DOWN: structured chip flattened to its label in choices.
    expect(seen[0]).toEqual({ promptId: "id-1", prompt: "How to integrate?", choices: ["merge", "rebase"] })
    // UP: chosen label is the value.
    expect(res).toEqual({ ok: true, value: "rebase" })
  })

  it("select: an OFF-MENU answer is invalid-input (fixed choice)", async () => {
    const { requester } = fakeRequester(answer("squash"))
    const port = createWebAskUserPort(requester, () => "x")
    const res = await port.ask({ kind: "select", prompt: "p", options: ["merge", "rebase"] })
    expect(res).toEqual({ ok: false, reason: "invalid-input" })
  })

  it("select/multiselect with zero options → empty-options WITHOUT prompting", async () => {
    const { requester, seen } = fakeRequester(answer("x"))
    const port = createWebAskUserPort(requester, () => "x")
    expect(await port.ask({ kind: "select", prompt: "p", options: [] })).toEqual({ ok: false, reason: "empty-options" })
    expect(await port.ask({ kind: "multiselect", prompt: "p", options: [] })).toEqual({ ok: false, reason: "empty-options" })
    expect(seen).toHaveLength(0) // never called the requester
  })

  it("multiselect: comma-separated free text → deduped string[] (labels validated)", async () => {
    const { requester, seen } = fakeRequester(answer("a, c , a"))
    const port = createWebAskUserPort(requester, () => "m")
    const res = await port.ask({ kind: "multiselect", prompt: "pick", options: ["a", "b", "c"] })
    expect(seen[0]?.prompt).toBe("pick (comma-separated)")
    expect(res).toEqual({ ok: true, value: ["a", "c"] })
  })

  it("multiselect: an unknown token → invalid-input; minSelected → validation-error", async () => {
    const bad = createWebAskUserPort(fakeRequester(answer("a,zzz")).requester, () => "m")
    expect(await bad.ask({ kind: "multiselect", prompt: "p", options: ["a", "b"] })).toEqual({ ok: false, reason: "invalid-input" })
    const tooFew = createWebAskUserPort(fakeRequester(answer("a")).requester, () => "m")
    expect(await tooFew.ask({ kind: "multiselect", prompt: "p", options: ["a", "b"], minSelected: 2 })).toEqual({ ok: false, reason: "validation-error" })
  })

  it("boolean: yes/no free text → typed boolean; garbage → invalid-input", async () => {
    expect(await createWebAskUserPort(fakeRequester(answer("Yes")).requester, () => "b").ask({ kind: "boolean", prompt: "p" })).toEqual({ ok: true, value: true })
    expect(await createWebAskUserPort(fakeRequester(answer("n")).requester, () => "b").ask({ kind: "boolean", prompt: "p" })).toEqual({ ok: true, value: false })
    expect(await createWebAskUserPort(fakeRequester(answer("maybe")).requester, () => "b").ask({ kind: "boolean", prompt: "p" })).toEqual({ ok: false, reason: "invalid-input" })
  })

  it("number/integer: parses + range-validates; integer rejects a fraction", async () => {
    expect(await createWebAskUserPort(fakeRequester(answer("3.5")).requester, () => "n").ask({ kind: "number", prompt: "p", min: 0, max: 10 })).toEqual({ ok: true, value: 3.5 })
    expect(await createWebAskUserPort(fakeRequester(answer("3.5")).requester, () => "n").ask({ kind: "integer", prompt: "p" })).toEqual({ ok: false, reason: "validation-error" })
    expect(await createWebAskUserPort(fakeRequester(answer("99")).requester, () => "n").ask({ kind: "number", prompt: "p", max: 10 })).toEqual({ ok: false, reason: "validation-error" })
    expect(await createWebAskUserPort(fakeRequester(answer("abc")).requester, () => "n").ask({ kind: "number", prompt: "p" })).toEqual({ ok: false, reason: "invalid-input" })
  })

  it("string: min/max length + pattern validation; multiline flag set", async () => {
    const { requester, seen } = fakeRequester(answer("hello"))
    const port = createWebAskUserPort(requester, () => "s")
    expect(await port.ask({ kind: "string", prompt: "p" })).toEqual({ ok: true, value: "hello" })
    expect(seen[0]?.multiline).toBe(true)
    expect(await createWebAskUserPort(fakeRequester(answer("hi")).requester, () => "s").ask({ kind: "string", prompt: "p", minLength: 3 })).toEqual({ ok: false, reason: "validation-error" })
    expect(await createWebAskUserPort(fakeRequester(answer("hello")).requester, () => "s").ask({ kind: "string", prompt: "p", pattern: "^[0-9]+$" })).toEqual({ ok: false, reason: "validation-error" })
  })

  it("cancelled answer → { ok:false, reason:'cancelled' } for any kind", async () => {
    const port = createWebAskUserPort(fakeRequester(cancelled).requester, () => "c")
    expect(await port.ask({ kind: "select", prompt: "p", options: ["a"] })).toEqual({ ok: false, reason: "cancelled" })
    expect(await port.ask({ kind: "string", prompt: "p" })).toEqual({ ok: false, reason: "cancelled" })
  })
})
