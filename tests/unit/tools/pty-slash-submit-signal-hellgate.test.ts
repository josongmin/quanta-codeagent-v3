/**
 * ★ HELLGATE — a PTY slash submit waits for the `/` to REGISTER, not for a clock.
 *
 * MEASURED DEFECT (2026-09-02 gate audit): both PTY suites that type slash
 * commands carry a copied helper whose whole defence against a dropped leading
 * `/` is `sleep(500)`. Under load the `/` races raw-input arming and loses; the
 * line then submits as an ordinary model prompt. Observed: the rendered input
 * lane read `› cost` (no slash), an unintended turn ran, and because the replay
 * cassette hashes every request to the constant `"replay"` it is a strict
 * one-record budget — so the extra turn exhausted it and the failure surfaced
 * 60s later as a `ReplayMissError`, nowhere near its cause.
 *
 * A sleep cannot be right: it is either too short under contention or pure
 * latency in every green run. The prompt paints `› ` (U+203A) and the typed
 * slash is visible as `› /`, so registration is OBSERVABLE — the helper waits
 * for that and, when it never appears, fails AT the drop naming it.
 *
 * This pins the shared helper's contract as a pure function of a screen reader
 * plus a keystroke sink, so it can be driven without a real terminal.
 */

import { describe, expect, test } from "bun:test"
import { submitPtyLine, typePtyLine } from "../../../tools/dev/pty-slash-submit"

/** A fake terminal: keystrokes accumulate, and the "screen" is what registered. */
const terminal = (
  opts: { readonly dropLeadingSlashes?: number; readonly scrollback?: string } = {},
) => {
  let drops = opts.dropLeadingSlashes ?? 0
  let line = ""
  const sent: string[] = []
  return {
    sent,
    send: (data: string): void => {
      sent.push(data)
      if (data === "\r") {
        line = ""
        return
      }
      if (data === "/" && drops > 0) {
        drops -= 1
        return
      }
      line += data
    },
    // Prior scrollback, then the input lane. A real terminal is full of
    // slashes (paths, URLs) ABOVE the prompt, so "the screen contains a /" is
    // not the same question as "the keystroke registered".
    screen: (): string => `${opts.scrollback ?? ""}› ${line}`,
  }
}

describe("submitPtyLine — the leading slash is confirmed, never assumed", () => {
  test("a slash command types through once the slash registers", async () => {
    const t = terminal()

    await submitPtyLine(t, "/cost", { sleep: async () => undefined })

    expect(t.screen()).toBe("› ")
    expect(t.sent.join("")).toBe("/cost\r")
  })

  test("a DROPPED leading slash is retyped, and the command still submits intact", async () => {
    const t = terminal({ dropLeadingSlashes: 2 })

    await submitPtyLine(t, "/cost", { sleep: async () => undefined })

    // Exactly one slash reached the line — the retries did not stack `///`.
    expect(t.sent.join("")).toBe("///cost\r")
    expect(t.sent.filter((k) => k === "/")).toHaveLength(3)
  })

  test("a slash that NEVER registers fails at the drop, naming it", async () => {
    const t = terminal({ dropLeadingSlashes: Number.POSITIVE_INFINITY })

    await expect(submitPtyLine(t, "/cost", { sleep: async () => undefined })).rejects.toThrow(
      /leading .* never registered/i,
    )

    // And it did NOT submit — an unconfirmed slash must not become a model prompt,
    // which is the whole failure this helper exists to prevent.
    expect(t.sent).not.toContain("\r")
  })

  test("a slash in the SCROLLBACK is not mistaken for the keystroke", async () => {
    // The drop never ends, so the only way this resolves is by matching the
    // stray `/` in prior output — which is exactly the bug an unanchored
    // "screen contains /" check would ship.
    const t = terminal({
      dropLeadingSlashes: Number.POSITIVE_INFINITY,
      scrollback: "wrote /tmp/session/abc.json\n",
    })

    await expect(submitPtyLine(t, "/cost", { sleep: async () => undefined })).rejects.toThrow(
      /leading .* never registered/i,
    )
  })

  test("PAIRED CONTROL — a non-slash line is typed verbatim with no probing", async () => {
    const t = terminal({ dropLeadingSlashes: 5 })

    await submitPtyLine(t, "spend once", { sleep: async () => undefined })

    expect(t.sent.join("")).toBe("spend once\r")
  })

  test("typePtyLine confirms the slash but does NOT submit — a draft stays a draft", async () => {
    const t = terminal({ dropLeadingSlashes: 1 })

    await typePtyLine(t, "/goal", { sleep: async () => undefined })

    expect(t.sent).not.toContain("\r")
    expect(t.screen()).toBe("› /goal")
  })

  test("ANTI-VACUITY — the fake terminal really can drop a slash", () => {
    const t = terminal({ dropLeadingSlashes: 1 })
    t.send("/")
    expect(t.screen()).toBe("› ")
    t.send("/")
    expect(t.screen()).toBe("› /")
  })
})
