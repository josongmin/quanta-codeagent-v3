/**
 * §10.2 byte-identity hellgate — argv-array support is a SUPERSET extension.
 *
 * Invariant: a rule document that contains ZERO bracketed token arrays must
 * produce a parse result + match outcomes that are byte-identical to the
 * pre-§10.2 behaviour. This pins the default-OFF contract: the new feature is
 * inert unless a `[...]` literal is present in the source.
 *
 * Method: a corpus of legacy string-prefix rule docs is parsed and matched
 * against a battery of commands. Every rule MUST have `argv === undefined`
 * (no accidental argv synthesis), and the matched-rule prefix MUST equal the
 * exact byte-prefix the legacy matcher would have selected.
 */
import { describe, expect, test } from "bun:test"
import { matchCommand, parseRules } from "@/rules"

const LEGACY_DOC = [
  "# default policy",
  "allow git status",
  "allow git diff",
  "ask git push",
  "deny git push --force",
  "allow ls",
  "allow echo # not a comment",
  "allow rm -rf /tmp/scratch",
].join("\n")

describe("§10.2 byte-identity — legacy docs untouched", () => {
  test("no rule in a bracket-free doc carries an argv field", () => {
    const rules = parseRules(LEGACY_DOC, "system", "default.rules")
    for (const r of rules) {
      expect(r.argv).toBeUndefined()
    }
  })

  test("parsed prefixes are byte-identical to the legacy expectation", () => {
    const rules = parseRules(LEGACY_DOC, "system", "default.rules")
    expect(rules.map((r) => `${r.action} ${r.prefix}`)).toEqual([
      "allow git status",
      "allow git diff",
      "ask git push",
      "deny git push --force",
      "allow ls",
      "allow echo # not a comment",
      "allow rm -rf /tmp/scratch",
    ])
  })

  const cases: ReadonlyArray<readonly [cmd: string, action: string | null]> = [
    ["git status --short", "allow"],
    ["git diff HEAD~1", "allow"],
    ["git push origin main", "ask"],
    ["git push --force origin main", "deny"],
    ["ls -la", "allow"],
    ["github status", null], // space-boundary still rejects
    ["npm test", null],
  ]

  for (const [cmd, action] of cases) {
    test(`match("${cmd}") is byte-identical to legacy => ${action ?? "no_match"}`, () => {
      const rules = parseRules(LEGACY_DOC, "system", "default.rules")
      const m = matchCommand(cmd, rules)
      if (action === null) {
        expect(m).toEqual({ kind: "no_match" })
      } else {
        expect(m.kind).toBe("matched")
        if (m.kind === "matched") expect(m.rule.action as string).toBe(action)
      }
    })
  }
})
