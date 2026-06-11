/**
 * #20 DURABLE prefix grant — `registry.grant({ commandPattern })` persists a
 * TOKEN-PREFIX grant that survives across registry instances (i.e. across
 * sessions / process restarts).
 *
 * Before this, the persistent registry's `grant()` dropped `commandPattern`
 * (it built the record from `{tool, scope, actionKey}` only), so the
 * token-prefix `patternMatchesAction` cascade could ONLY fire for hand-authored
 * grants.json records — the programmatic "always allow `git …`" verb was
 * impossible. This pins: a granted `commandPattern` (a) matches a sibling by
 * token-prefix, (b) does NOT match a different program (token-boundary), and
 * (c) is read back by a FRESH registry instance over the same state file.
 *
 * RED-ON-INJECTION (manually verified): reverting `doGrant` to drop
 * `commandPattern` makes the sibling lookup return false (no record carries a
 * pattern) ⇒ the match + persistence assertions flip RED.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPersistentTrustScopeRegistry } from "@/permission"

let dir: string
let statePath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trust-durable-"))
  statePath = join(dir, "grants.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("#20 durable prefix grant — commandPattern persists + token-prefix matches", () => {
  test("a granted commandPattern matches a sibling by token-prefix, not a different program", async () => {
    const reg = createPersistentTrustScopeRegistry({ filePath: statePath })
    await reg.hydrate()
    reg.grant("proj", { tool: "bash", scope: "project", commandPattern: "git" })
    await reg.flush()

    // sibling git commands match (token-prefix)…
    expect(reg.hasGrant("proj", { tool: "bash", actionKey: "bash|git log --oneline" })).toBe(true)
    expect(reg.hasGrant("proj", { tool: "bash", actionKey: "bash|git diff HEAD~1" })).toBe(true)
    // …a different program sharing the prefix string does NOT (token-boundary)…
    expect(reg.hasGrant("proj", { tool: "bash", actionKey: "bash|github-dump" })).toBe(false)
    // …and a different tool never rides it.
    expect(reg.hasGrant("proj", { tool: "edit", actionKey: "edit" })).toBe(false)
  })

  test("PERSISTENCE: a FRESH registry over the same file reads the durable grant (cross-session)", async () => {
    const a = createPersistentTrustScopeRegistry({ filePath: statePath })
    await a.hydrate()
    a.grant("proj", { tool: "bash", scope: "project", commandPattern: "npm" })
    await a.flush() // durably written

    // A brand-new registry instance (simulating the next session / restart).
    const b = createPersistentTrustScopeRegistry({ filePath: statePath })
    await b.hydrate()
    expect(b.hasGrant("proj", { tool: "bash", actionKey: "bash|npm test" })).toBe(true)
    expect(b.hasGrant("proj", { tool: "bash", actionKey: "bash|cargo build" })).toBe(false)
  })
})
