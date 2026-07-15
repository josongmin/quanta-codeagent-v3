/**
 * WS4 R7 — the web/Tauri daemon is a TRUSTED user-repo surface (it runs on the
 * user's OWN `process.cwd()`, and already publishes the "interactive" prompt
 * surface profile), so it must honor the repo's AGENTS.md/CLAUDE.md exactly like
 * the CLI interactive preset. R6's audit flagged that it was the one trusted
 * surface still dropping repo rules (a surface-parity gap).
 *
 * `buildAgentConfigBase` binds `cwd` to `process.cwd()` and needs the full
 * production dep bundle (LLM/env/registry/…), so — matching the established
 * web-daemon wiring-hellgate idiom (runtime-factory.test.ts) — this pins the
 * wiring at the source: the daemon loads repo rules and threads them into the
 * assembled base. Remove either and this goes RED, so the trusted-surface parity
 * cannot silently regress.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = readFileSync(
  join(import.meta.dir, "../../../../src/apps/web-daemon/runtime-factory.ts"),
  "utf8",
)

describe("WS4 R7 — web-daemon honors repo-local rules (trusted surface parity)", () => {
  test("imports the repo-rules loader", () => {
    expect(SRC).toMatch(/import\s*\{\s*loadRepoRules\s*\}\s*from\s*"@\/agent\/repo-rules"/)
  })

  test("loads rules from the session cwd, reports a failure, then fails open", () => {
    expect(SRC).toMatch(
      /loadRepoRules\(cwd\)\.catch\(\(e\)\s*=>\s*\{[\s\S]{0,350}?logger\.warn\([\s\S]{0,350}?return undefined[\s\S]{0,80}?\}\)/,
    )
  })

  test("threads the loaded rules into the assembled base config", () => {
    // Conditional spread so the absent case stays byte-identical.
    expect(SRC).toMatch(/\.\.\.\(repoRules !== undefined \? \{ repoRules \} : \{\}\)/)
  })

  // R8 — the load decision is GATED on the SSOT policy `modeLoadsRepoRules`
  // (shared `@/agent/run-mode`), so web can never drift from the security
  // classification. Remove the gate and this goes RED.
  test("gates the load on the shared SSOT policy (modeLoadsRepoRules), not a hand-copy", () => {
    expect(SRC).toMatch(/import\s*\{\s*modeLoadsRepoRules\s*\}\s*from\s*"@\/agent\/run-mode"/)
    expect(SRC).toMatch(/modeLoadsRepoRules\("interactive"\)/)
  })
})
