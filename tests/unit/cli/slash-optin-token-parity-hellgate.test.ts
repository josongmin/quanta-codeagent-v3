/**
 * Hellgate — a slash command's `Opt-in:` token must be the token the surface's own
 * hint prints, and the gate must actually accept it.
 *
 * WHY THIS EXISTS. `/cron`'s `describe` read `Opt-in: QUANTA_AUTOMATION=on` while
 * every not-wired site for the same gate printed `hint: set QUANTA_AUTOMATION=1`.
 * Two operator-facing strings about one switch, in two files, disagreeing.
 *
 * Before `db4e5f7` only ONE of them was even true: the gate was strict
 * `=== "on"`, so `=1` — the token the hint recommended — did nothing. That commit
 * widened the gate to the canonical truthy set so the hint stopped lying, and left
 * `/cron`'s own description on the other token. The campaign that fixed the gate so
 * the hint would be honest did not check the command's own help text.
 *
 * METHOD. Two axes, neither string-to-string:
 *
 *  1. the expected token is DERIVED by rendering the real `notWired` helper, so if
 *     the shared vocabulary ever changes the expectation follows it;
 *  2. the token is fed to the real `isTruthyToken` from `@/shared`, so a describe
 *     cannot recommend something the gate would refuse.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { notWired } from "@/apps/cli/not-wired"
import { isTruthyToken } from "@/shared"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** The token the shared not-wired hint recommends, read out of its own output. */
const sharedHintToken = (): string => {
  let text = ""
  notWired(
    (c) => {
      text += c
    },
    { feature: "/probe", gate: "QUANTA_PROBE" },
  )
  const m = /QUANTA_PROBE=(\S+)/.exec(text)
  if (m === null) throw new Error(`notWired no longer names a token: ${text}`)
  return m[1] as string
}

interface OptIn {
  readonly file: string
  readonly line: number
  readonly key: string
  readonly token: string
}

/** Every `Opt-in: QUANTA_X=<token>` in a slash command's operator-facing text. */
const optIns = (): OptIn[] => {
  const files = execFileSync("git", ["ls-files", "--", "src/apps/cli"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !f.includes("/__tests__/"))
  const out: OptIn[] = []
  for (const rel of files) {
    const lines = readFileSync(join(REPO_ROOT, rel), "utf8").split("\n")
    for (let i = 0; i < lines.length; i++) {
      // The token runs to a delimiter OR to end of line. The first version required
      // a trailing `["',\s]`, so a describe written as a TEMPLATE literal whose line
      // ends at the token evaded it entirely — measured: `Opt-in: QUANTA_AUTOMATION=on`
      // at end of line inside a backtick string left the guard at 4 pass / 0 fail
      // while `/help` printed the forbidden token.
      for (const m of (lines[i] as string).matchAll(/Opt-in: (QUANTA_[A-Z0-9_]+)=([^\s"'`,)]+)/g)) {
        out.push({ file: rel, line: i + 1, key: m[1] as string, token: m[2] as string })
      }
    }
  }
  return out
}

describe("slash Opt-in token parity", () => {
  /**
   * The population is PINNED as a set, not floored as a count.
   *
   * A `> 4` floor against a real population of six cannot see one row go missing —
   * the same blindness, in the same file, as the regex hole above. Naming the keys
   * makes a disappearing `Opt-in:` string a failure instead of a smaller number.
   */
  test("ANTI-VACUITY: the Opt-in population is exactly the known set", () => {
    const keys = [...new Set(optIns().map((o) => o.key))].sort()
    expect(keys).toEqual([
      "QUANTA_ATTENTION_NAV",
      "QUANTA_AUTOMATION",
      "QUANTA_POSTURE_SELECTOR",
      "QUANTA_RADAR",
      "QUANTA_SKILL_ACTIONS",
      "QUANTA_VOICE_LIVE",
    ])
  })

  test("every Opt-in names the same token the shared hint recommends", () => {
    const expected = sharedHintToken()
    expect(expected).toBe("1")
    const wrong = optIns().filter((o) => o.token !== expected)
    expect(
      wrong.map((o) => `${o.file}:${o.line} ${o.key}=${o.token} (hint says =${expected})`),
      "a command's own help recommends a different token than its not-wired hint",
    ).toEqual([])
  })

  test("every Opt-in token is one the canonical gate vocabulary accepts", () => {
    const refused = optIns().filter((o) => !isTruthyToken(o.token))
    expect(
      refused.map((o) => `${o.file}:${o.line} ${o.key}=${o.token}`),
      "a command's help recommends a token the gate would refuse",
    ).toEqual([])
  })

  /** PAIRED CONTROL: the vocabulary check must be capable of refusing. */
  test("the vocabulary check is not vacuous", () => {
    expect(isTruthyToken("1")).toBe(true)
    expect(isTruthyToken("on")).toBe(true)
    expect(isTruthyToken("0")).toBe(false)
    expect(isTruthyToken("banana")).toBe(false)
  })
})
