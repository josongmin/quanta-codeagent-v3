import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent } from "@/llm"
// NOTE: import via concrete module paths rather than the `@/agent` / `@/shared`
// barrels. Importing `RetryingLLM` from `@/agent` transitively loads the whole
// `@/shared` barrel graph; a concurrently-edited consumer there can leave the
// barrel in a half-wired state. These deep imports keep this proof hermetic to
// the two files under test.
import { RetryingLLM } from "../../src/agent/retry"
import { LLMError } from "../../src/shared/errors"
import { applyExactEdit } from "../../src/tool/edit/exact"

/** T4-edit-retry hellgate battery.
 *
 *  (a) `applyExactEdit` non-replace_all path must splice the single match
 *      literally — `String.prototype.replace(str, str)` interprets `$&`, `$1`,
 *      `` $` ``, `$'`, `$$` in the replacement as specials, silently corrupting
 *      inserted code. These adversarial new_strings are the exact bytes that
 *      caught the bug.
 *  (b) `throwIfAborted` must throw `LLMError{kind:"aborted"}` so it matches
 *      `FATAL_KINDS` (never retried) and the loop's `e.kind==="aborted"`
 *      cancel-routing — not the constructor default `kind:"unknown"`.
 */
describe("applyExactEdit literal-splice (no $-pattern interpretation)", () => {
  // newString → expected verbatim result of inserting it at the single match.
  const adversarial: ReadonlyArray<readonly [string, string]> = [
    ["$&", "$&"], // would re-insert the whole match
    ["$1", "$1"], // would insert capture group / empty
    ["$`", "$`"], // would insert the prefix
    ["$'", "$'"], // would insert the suffix
    ["$$", "$$"], // would collapse to a single `$`
    ["a$&b$$c", "a$&b$$c"], // mixed specials inside real code
  ]

  for (const [newString, expectedInsert] of adversarial) {
    test(`new_string ${JSON.stringify(newString)} is inserted verbatim`, () => {
      const r = applyExactEdit("PRE<HOLE>POST", "<HOLE>", newString, false)
      expect(r.ok).toBe(true)
      expect(r.next).toBe(`PRE${expectedInsert}POST`)
    })
  }

  test("only the single guaranteed match is spliced (count===1 invariant)", () => {
    const r = applyExactEdit("xTOKENy", "TOKEN", "$&$&", false)
    expect(r.ok).toBe(true)
    // A naive .replace would expand `$&$&` to `TOKENTOKEN`; the literal splice
    // keeps the bytes as written.
    expect(r.next).toBe("x$&$&y")
  })

  test("replace_all path is likewise literal (split/join, regression guard)", () => {
    const r = applyExactEdit("a a", "a", "$&", true)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("$& $&")
  })
})

class NeverCalledLLM implements LLMPort {
  calls = 0
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "text_delta", delta: "should-not-run" }
  }
}

describe("RetryingLLM honors a pre-aborted signal as a typed abort", () => {
  test("already-aborted signal throws LLMError{kind:'aborted'}, never retries", async () => {
    const ac = new AbortController()
    ac.abort()
    const inner = new NeverCalledLLM()
    let slept = 0
    const wrapped = new RetryingLLM({
      inner,
      signal: ac.signal,
      maxRetries: 4,
      sleep: async () => {
        slept += 1
      },
    })

    let thrown: unknown
    try {
      for await (const _ of wrapped.stream({} as never)) {
        // unreachable
      }
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(LLMError)
    // The bug: constructor default left kind="unknown", so the loop's
    // cancel-routing (`e.kind === "aborted"`) and FATAL_KINDS membership both
    // missed it. Assert the discriminator is the abort kind.
    expect((thrown as LLMError).kind).toBe("aborted")
    // Aborted before the first attempt: inner stream must never run, and no
    // backoff sleep may occur (abort is fatal, not retryable).
    expect(inner.calls).toBe(0)
    expect(slept).toBe(0)
  })
})
