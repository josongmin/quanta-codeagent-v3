/**
 * hell-audit R4 — SECURITY PIN for the repo-local-rules trust classification.
 *
 * WHY THIS EXISTS (and is NOT redundant with the R8 drift guard):
 * `mode-classification-drift-guard-hellgate.test.ts` proves the Record is TOTAL
 * over AgentMode and that `modeLoadsRepoRules` AGREES with the Record. But the
 * agreement check is DERIVED from the Record — flipping a cell flips both the
 * Record and the predicate together, so the agreement stays green. That test's
 * one literal check pins only the DERIVED boolean (`modeLoadsRepoRules → false`),
 * never the RAW Record string-value.
 *
 * This file is an INDEPENDENT ORACLE: it hard-codes the expected classification
 * for every mode as LITERAL constants written out here (NOT read back from the
 * SSOT Record / union), pinning BOTH surfaces separately —
 *   • the raw SSOT cell   `MODE_REPO_RULES_POLICY[mode]` (string value), and
 *   • the shared predicate `modeLoadsRepoRules(mode)` (boolean).
 *
 * The R4 vuln (introduced-then-caught): flipping an UNTRUSTED mode to `"load"`
 * renders an attacker-authored AGENTS.md from a PR/webhook worktree into the
 * TRUSTED system prompt's authoritative "Rules" — a malicious PR self-approves,
 * defeating ci-bot's `<pr_untrusted_data>` fence.
 */

import { describe, expect, test } from "bun:test"
import { MODE_REPO_RULES_POLICY, modeLoadsRepoRules } from "@/agent"

describe("R4 §1 — UNTRUSTED modes MUST stay rule-less (attacker-authored AGENTS.md never enters the trusted prompt)", () => {
  // ci-bot = a PR checkout. Its working tree is authored by an untrusted
  // contributor; auto-loading its AGENTS.md would let a malicious PR
  // self-approve. red-on-injection: flip "ci-bot" to "load" in the SSOT Record
  // ⇒ THIS test RED = the R4 prompt-injection self-approve regression.
  test("ci-bot (PR checkout) is rule-less — both the raw Record cell AND the predicate", () => {
    expect(MODE_REPO_RULES_POLICY["ci-bot"]).toBe("rule-less")
    expect(modeLoadsRepoRules("ci-bot")).toBe(false)
  })

  // daemon = a host-created PR/webhook worktree. Same untrusted-origin hazard as
  // ci-bot. red-on-injection: flip "daemon" to "load" in the SSOT Record
  // ⇒ THIS test RED = the R4 prompt-injection self-approve regression.
  test("daemon (host PR/webhook worktree) is rule-less — both the raw Record cell AND the predicate", () => {
    expect(MODE_REPO_RULES_POLICY.daemon).toBe("rule-less")
    expect(modeLoadsRepoRules("daemon")).toBe(false)
  })

  // batch = a hermetic bench sandbox. Not attacker-controlled, but hermetic:
  // it must never reach into a working tree's rules either.
  test("batch (hermetic bench sandbox) is rule-less — both the raw Record cell AND the predicate", () => {
    expect(MODE_REPO_RULES_POLICY.batch).toBe("rule-less")
    expect(modeLoadsRepoRules("batch")).toBe(false)
  })
})

describe("R4 §2 — TRUSTED user-repo modes DO load (paired control: proves the pins above aren't vacuously all-false)", () => {
  // interactive = the end user's own chosen repo. Honoring its AGENTS.md is the
  // intended, trusted behavior.
  test("interactive (user's own repo) loads — both the raw Record cell AND the predicate", () => {
    expect(MODE_REPO_RULES_POLICY.interactive).toBe("load")
    expect(modeLoadsRepoRules("interactive")).toBe(true)
  })

  // headless = the user driving their own repo non-interactively.
  test("headless (user's own repo, non-interactive) loads — both the raw Record cell AND the predicate", () => {
    expect(MODE_REPO_RULES_POLICY.headless).toBe("load")
    expect(modeLoadsRepoRules("headless")).toBe(true)
  })

  // ide = editor-embedded on the user's open project.
  test("ide (editor-embedded on user's project) loads — both the raw Record cell AND the predicate", () => {
    expect(MODE_REPO_RULES_POLICY.ide).toBe("load")
    expect(modeLoadsRepoRules("ide")).toBe(true)
  })
})
