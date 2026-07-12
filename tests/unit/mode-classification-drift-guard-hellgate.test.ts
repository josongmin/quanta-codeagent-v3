/**
 * hell-audit R8 — cross-cutting drift guard for per-AgentMode classification.
 *
 * `ALL_AGENT_MODES` (run-mode/types.ts) is the SSOT list with a BOTH-direction
 * compile guard. R8 closed two places that duplicated/mirrored the mode list
 * WITHOUT linking to it, so a newly-added mode could slip through:
 *   - CLI `VALID_MODES` (agent-args.ts) lacked `satisfies` — now aliases
 *     ALL_AGENT_MODES, so `--mode <newmode>` is accepted by construction.
 *   - `MODE_REPO_RULES_POLICY` / web-daemon — now a `Record<AgentMode>` in the
 *     shared `@/agent/run-mode` layer (compile-forced total).
 *
 * These runtime cross-checks fail if any of those links regress to a manual copy
 * that drifts from ALL_AGENT_MODES.
 */

import { describe, expect, test } from "bun:test"
import { ALL_AGENT_MODES, MODE_REPO_RULES_POLICY, modeLoadsRepoRules, type RunMode } from "@/agent"
import { parseAgentArgs } from "../../src/host/runtime/agent-args"

describe("R8 §1 — the CLI --mode parser accepts EVERY AgentMode (VALID_MODES ⊇ union)", () => {
  test("no ALL_AGENT_MODES value is rejected by the --mode enum check", () => {
    for (const mode of ALL_AGENT_MODES) {
      try {
        // `-p x` satisfies the prompt-required modes; other mode-specific
        // required args (if any) surface as a DIFFERENT error, which is fine —
        // the drift guard only asserts the mode VALUE itself is accepted.
        const parsed = parseAgentArgs(["--mode", mode, "-p", "x"])
        expect(parsed.mode, mode).toBe(mode)
      } catch (e) {
        expect(
          String((e as Error).message),
          `--mode ${mode} must not be enum-rejected`,
        ).not.toContain("--mode must be one of")
      }
    }
  })
})

describe("R8 §2 — the repo-rules policy is total over AgentMode and self-consistent", () => {
  test("MODE_REPO_RULES_POLICY covers EXACTLY the AgentMode union", () => {
    const keys = Object.keys(MODE_REPO_RULES_POLICY).sort()
    expect(keys).toEqual([...ALL_AGENT_MODES].sort())
  })

  test("modeLoadsRepoRules agrees with the Record for every mode", () => {
    for (const mode of ALL_AGENT_MODES) {
      expect(modeLoadsRepoRules(mode), mode).toBe(MODE_REPO_RULES_POLICY[mode] === "load")
    }
  })

  test("the trusted user-repo modes load; hermetic/untrusted modes stay rule-less", () => {
    const LOADS: readonly RunMode[] = ["interactive", "headless", "ide"]
    const RULE_LESS: readonly RunMode[] = ["batch", "ci-bot", "daemon"]
    for (const m of LOADS) expect(modeLoadsRepoRules(m), `${m} loads`).toBe(true)
    for (const m of RULE_LESS) expect(modeLoadsRepoRules(m), `${m} rule-less`).toBe(false)
    // The two lists together are the whole union (no mode unclassified).
    expect([...LOADS, ...RULE_LESS].sort()).toEqual([...ALL_AGENT_MODES].sort())
  })
})
