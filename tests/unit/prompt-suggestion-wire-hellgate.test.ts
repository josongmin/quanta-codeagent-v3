/**
 * Adversarial hellgate for `apps/cli/repl/prompt-suggestion-wire.ts` (ADR-0467).
 *
 * Proves the composition-root binding holds its three contracts under hostile
 * inputs:
 *   1. GATE-OFF ⇒ NOOP / zero-alloc: `maybeCreatePromptSuggestionWire` returns
 *      `null` and NEVER touches the injected `LLMPort` (zero `stream()` calls)
 *      for every non-`"1"` env value.
 *   2. GATE-ON ⇒ adapter constructed + port satisfied: a wire is returned, and
 *      an accepted suggestion drives `render(text)` exactly once with the
 *      sanitized text; the adapter denies tools (`tools: []`) and uses the
 *      SUGGESTION-MODE system prompt.
 *   3. Adapter failure caught (no throw): a `stream()` that throws, a stream
 *      that rejects mid-iteration, and a render callback that throws all
 *      resolve `run()` WITHOUT throwing and WITHOUT rendering bad output.
 */

import { describe, expect, test } from "bun:test"
import { SUGGESTION_MODE_SYSTEM_PROMPT } from "@/agent/prompt-suggestion"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  buildSuggestFnAdapter,
  maybeCreatePromptSuggestionWire,
  type PromptSuggestionRunArgs,
} from "../../src/apps/cli/repl/prompt-suggestion-wire"

const ON = { QUANTA_ENABLE_PROMPT_SUGGESTION: "1" } as const

const calmState = {
  planMode: false,
  rateLimited: false,
  elicitationActive: false,
  pendingPermission: false,
}

const baseArgs = (over?: Partial<PromptSuggestionRunArgs>): PromptSuggestionRunArgs => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "add a test" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ],
  state: calmState,
  ...over,
})

/** An LLMPort whose `stream` yields the supplied events and records every call
 *  + the StreamInput it saw. */
const stubLlm = (events: StreamEvent[]): { llm: LLMPort; calls: StreamInput[] } => {
  const calls: StreamInput[] = []
  const llm: LLMPort = {
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      calls.push(input)
      return (async function* () {
        for (const ev of events) yield ev
      })()
    },
  }
  return { llm, calls }
}

const textDelta = (delta: string): StreamEvent => ({ type: "text_delta", delta })

describe("prompt-suggestion-wire — gate-OFF zero-alloc", () => {
  for (const value of [undefined, "", "0", "true", "on", "ON", "yes", " 1", "1 "]) {
    test(`gate value ${JSON.stringify(value)} ⇒ null wire, zero stream() calls`, async () => {
      const { llm, calls } = stubLlm([textDelta("<suggestion>push the branch</suggestion>")])
      let rendered = 0
      const env = value === undefined ? {} : { QUANTA_ENABLE_PROMPT_SUGGESTION: value }
      const wire = maybeCreatePromptSuggestionWire(env, llm, () => {
        rendered += 1
      })
      expect(wire).toBeNull()
      expect(calls.length).toBe(0)
      expect(rendered).toBe(0)
    })
  }
})

describe("prompt-suggestion-wire — gate-ON adapter + port", () => {
  test("accepted suggestion renders sanitized text exactly once", async () => {
    const { llm, calls } = stubLlm([
      textDelta("<suggestion>push the "),
      textDelta("branch</suggestion>"),
    ])
    const renders: string[] = []
    const wire = maybeCreatePromptSuggestionWire(ON, llm, (t) => renders.push(t))
    expect(wire).not.toBeNull()
    await wire?.run(baseArgs())
    expect(renders).toEqual(["push the branch"])
    // Port satisfied: tools DENIED + SUGGESTION-MODE system prompt.
    expect(calls.length).toBe(1)
    expect(calls[0]?.tools).toEqual([])
    expect(calls[0]?.system).toBe(SUGGESTION_MODE_SYSTEM_PROMPT)
  })

  test("rejected model output (assistant voice) renders nothing — gate still consulted", async () => {
    const { llm, calls } = stubLlm([textDelta("<suggestion>let me push the branch</suggestion>")])
    const renders: string[] = []
    const wire = maybeCreatePromptSuggestionWire(ON, llm, (t) => renders.push(t))
    await wire?.run(baseArgs())
    expect(renders).toEqual([])
    expect(calls.length).toBe(1) // model WAS consulted; reject gate suppressed
  })

  test("suppression context (plan mode) ⇒ zero stream() calls", async () => {
    const { llm, calls } = stubLlm([textDelta("<suggestion>push the branch</suggestion>")])
    const renders: string[] = []
    const wire = maybeCreatePromptSuggestionWire(ON, llm, (t) => renders.push(t))
    await wire?.run(baseArgs({ state: { ...calmState, planMode: true } }))
    expect(renders).toEqual([])
    expect(calls.length).toBe(0) // suppression short-circuits BEFORE the model call
  })

  test("pre-aborted signal ⇒ no_output, zero stream() calls", async () => {
    const { llm, calls } = stubLlm([textDelta("<suggestion>push the branch</suggestion>")])
    const renders: string[] = []
    const wire = maybeCreatePromptSuggestionWire(ON, llm, (t) => renders.push(t))
    const ac = new AbortController()
    ac.abort()
    await wire?.run(baseArgs({ signal: ac.signal }))
    expect(renders).toEqual([])
    expect(calls.length).toBe(0)
  })
})

describe("prompt-suggestion-wire — no-throw under adapter failure", () => {
  test("stream() throws synchronously ⇒ run resolves, nothing rendered", async () => {
    const llm: LLMPort = {
      stream() {
        throw new Error("boom-sync")
      },
    }
    const renders: string[] = []
    const wire = maybeCreatePromptSuggestionWire(ON, llm, (t) => renders.push(t))
    await expect(wire?.run(baseArgs())).resolves.toBeUndefined()
    expect(renders).toEqual([])
  })

  test("stream rejects mid-iteration ⇒ run resolves, nothing rendered", async () => {
    const llm: LLMPort = {
      stream(): AsyncIterable<StreamEvent> {
        return (async function* () {
          yield textDelta("<suggestion>push")
          throw new Error("boom-mid")
        })()
      },
    }
    const renders: string[] = []
    const wire = maybeCreatePromptSuggestionWire(ON, llm, (t) => renders.push(t))
    await expect(wire?.run(baseArgs())).resolves.toBeUndefined()
    expect(renders).toEqual([])
  })

  test("render callback throws ⇒ run resolves (caught, no cascade)", async () => {
    const { llm } = stubLlm([textDelta("<suggestion>push the branch</suggestion>")])
    const wire = maybeCreatePromptSuggestionWire(ON, llm, () => {
      throw new Error("render-boom")
    })
    await expect(wire?.run(baseArgs())).resolves.toBeUndefined()
  })

  test("adapter alone: stream throw ⇒ Err (no throw past boundary)", async () => {
    const llm: LLMPort = {
      stream() {
        throw new Error("boom")
      },
    }
    const adapter = buildSuggestFnAdapter(llm, undefined)
    const res = await adapter(baseArgs().messages)
    expect(res.ok).toBe(false)
  })

  test("adapter ignores non-text events; collects only text_delta", async () => {
    const { llm } = stubLlm([
      { type: "thinking_delta", text: "reasoning" },
      textDelta("commit the "),
      { type: "usage", inputTokens: 1, outputTokens: 1, model: "m" },
      textDelta("change"),
    ])
    const adapter = buildSuggestFnAdapter(llm, undefined)
    const res = await adapter(baseArgs().messages)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value).toBe("commit the change")
  })
})
