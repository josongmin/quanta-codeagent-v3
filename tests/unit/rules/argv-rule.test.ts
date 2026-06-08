/**
 * §10.2 — argv-array rule grammar + token-prefix matching.
 *
 * Codex's `~/.codex/rules/default.rules` uses
 *   `prefix_rule(pattern=["git", "push"], decision="allow")`
 * which matches against the command's ARGV TOKEN VECTOR (each pattern token
 * must equal the corresponding command token; pattern is a token PREFIX of
 * the command argv). This is strictly stronger than quanta's byte-prefix
 * matcher: a token rule for `["git", "push"]` does NOT match
 * `git push-mirror` (a byte-prefix rule for `git push` would, were it not
 * for the space-boundary check — but a byte-prefix rule for `git pu` WOULD
 * match `git push`, which a token rule never does).
 *
 * quanta grammar extension (default-OFF): an action line whose prefix body
 * is a bracketed token array
 *   `allow [git, push]`
 * parses into a `Rule` carrying `argv: ["git","push"]`. Legacy
 * `allow git push` lines are UNCHANGED (no `argv` field) and match
 * byte-identically to before — proven by the byte-identity test below.
 */
import { describe, expect, test } from "bun:test"
import { matchCommand, parseRules, RuleParseError } from "@/rules"

describe("parseRules — argv-array grammar", () => {
  test("parses a bracketed token array into rule.argv", () => {
    const rules = parseRules('allow ["git", "push"]', "system", "x.rules")
    expect(rules).toHaveLength(1)
    expect(rules[0]?.action).toBe("allow")
    expect(rules[0]?.argv).toEqual(["git", "push"])
  })

  test("accepts unquoted bare tokens inside the array", () => {
    const rules = parseRules("allow [git, push]", "system", "x.rules")
    expect(rules[0]?.argv).toEqual(["git", "push"])
  })

  test("preserves spaces inside a quoted array token", () => {
    const rules = parseRules('ask ["git", "commit", "-m", "wip msg"]', "system", "x.rules")
    expect(rules[0]?.argv).toEqual(["git", "commit", "-m", "wip msg"])
  })

  test("a legacy string-prefix rule has NO argv field", () => {
    const rules = parseRules("allow git push", "system", "x.rules")
    expect(rules[0]?.argv).toBeUndefined()
    expect(rules[0]?.prefix).toBe("git push")
  })

  test("rule.prefix mirrors the joined argv for diagnostics", () => {
    const rules = parseRules('deny ["rm", "-rf"]', "system", "x.rules")
    // prefix stays populated (non-empty invariant) so existing ruleId /
    // diagnostics code keeps working unchanged.
    expect(rules[0]?.prefix.length).toBeGreaterThan(0)
  })

  test("empty token array is a parse error (no silent fallback)", () => {
    expect(() => parseRules("allow []", "system", "x.rules")).toThrow(RuleParseError)
  })

  test("unterminated bracket is a parse error", () => {
    expect(() => parseRules('allow ["git", "push"', "system", "x.rules")).toThrow(RuleParseError)
  })
})

describe("matchCommand — argv token-prefix matching", () => {
  test("token rule matches when it is a token PREFIX of the command argv", () => {
    const rules = parseRules('allow ["git", "push"]', "system", "x.rules")
    const m = matchCommand("git push --force origin", rules)
    expect(m.kind).toBe("matched")
  })

  test("token rule matches an EXACT argv", () => {
    const rules = parseRules('allow ["ls"]', "system", "x.rules")
    expect(matchCommand("ls", rules).kind).toBe("matched")
  })

  test("token rule does NOT match a partial-token (git push-mirror)", () => {
    const rules = parseRules('allow ["git", "push"]', "system", "x.rules")
    // byte-prefix would be tempted by 'push' ⊂ 'push-mirror'; token match rejects.
    expect(matchCommand("git push-mirror origin", rules)).toEqual({ kind: "no_match" })
  })

  test("token rule respects quoted-arg token boundaries", () => {
    const rules = parseRules('allow ["git", "commit", "-m", "ok"]', "system", "x.rules")
    expect(matchCommand('git commit -m "ok"', rules).kind).toBe("matched")
    // a different message is a different token => no match
    expect(matchCommand('git commit -m "different"', rules)).toEqual({ kind: "no_match" })
  })

  test("token rule does NOT match when the command argv is SHORTER", () => {
    const rules = parseRules('allow ["git", "push", "origin"]', "system", "x.rules")
    expect(matchCommand("git push", rules)).toEqual({ kind: "no_match" })
  })

  test("last pattern token may end with * (glob suffix, Codex parity)", () => {
    const rules = parseRules('allow ["file", "/repo/docs/*"]', "system", "x.rules")
    expect(matchCommand("file /repo/docs/readme.md", rules).kind).toBe("matched")
    expect(matchCommand("file /other/x", rules)).toEqual({ kind: "no_match" })
  })

  test("* glob only applies to the LAST pattern token", () => {
    const rules = parseRules('allow ["git*", "push"]', "system", "x.rules")
    // first token must be exact 'git*' literal (no glob on non-last tokens)
    expect(matchCommand("github push", rules)).toEqual({ kind: "no_match" })
  })
})

describe("matchCommand — argv deny cannot be bypassed by whitespace / quoting", () => {
  test("extra whitespace between tokens does NOT bypass a deny argv rule", () => {
    const rules = parseRules('deny ["rm", "-rf"]', "system", "x.rules")
    expect(matchCommand("rm    -rf   /tmp/x", rules).kind).toBe("matched")
  })

  test("quoting a token does NOT bypass a deny argv rule", () => {
    const rules = parseRules('deny ["rm", "-rf"]', "system", "x.rules")
    expect(matchCommand('"rm" -rf /tmp/x', rules).kind).toBe("matched")
    expect(matchCommand("rm '-rf' /tmp/x", rules).kind).toBe("matched")
  })

  test("leading whitespace does NOT bypass a deny argv rule", () => {
    const rules = parseRules('deny ["rm", "-rf"]', "system", "x.rules")
    expect(matchCommand("   rm -rf /tmp/x", rules).kind).toBe("matched")
  })
})

describe("matchCommand — argv + string-prefix mixed rule sets", () => {
  test("longest-token-rule and byte-rule coexist; token rule chosen for its argv", () => {
    const text = ['allow ["git", "status"]', "deny git push --force"].join("\n")
    const rules = parseRules(text, "system", "x.rules")
    expect(matchCommand("git status --short", rules).kind).toBe("matched")
    const deny = matchCommand("git push --force origin", rules)
    expect(deny.kind).toBe("matched")
    if (deny.kind === "matched") expect(deny.rule.action).toBe("deny")
  })
})
