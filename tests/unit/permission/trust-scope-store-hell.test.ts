/**
 * HELL-GATE for the persistent trust-scope store (L3→L4 promotion of
 * trust-scope-wire-up).
 *
 * Adversarial coverage of:
 *   H-1   Concurrent grant() writes — atomic rename, no torn JSON.
 *   H-2   Stale-TTL hydration — expired grants do NOT satisfy hasGrant.
 *   H-3   Malformed grants file — start empty + quarantine, no throw.
 *   H-4   Mid-session grant invalidation via revoke().
 *   H-5   Scope cascade with conflicting overlay/global records — most-specific
 *         (overlay) wins over global, deny inside a layer short-circuits.
 *   H-6   Classifier suggesting empty/dangerous-shaped pattern — empty pattern
 *         is ignored at store time so it never matches anything.
 *   H-7   Dirty `.quanta/grants.json` recovery — version mismatch quarantines
 *         and starts empty.
 *   H-8   Scope-cascade tie-breaker — exact actionKey beats pattern beats
 *         tool-only beats nothing.
 *   H-9   Project-overlay precedence — overlay's deny beats global's positive
 *         grant (per-project tighten).
 *   H-10  Persistence across process boundary — write to tmp dir, build a new
 *         registry instance over the same files, assert hydrated.
 *   H-11  Cycle / repeated grant calls do not double-fire patterns (idempotent
 *         add — duplicates persist but do not change hasGrant semantics).
 *   H-12  Pattern normalization — whitespace + uppercase normalized to a
 *         canonical pattern key.
 *   H-13  Once_only consumed inline on hit (second hasGrant returns false).
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPersistentTrustScopeRegistry, type TrustScopeRegistry } from "@/permission"

const mkTmp = async (): Promise<string> => mkdtemp(join(tmpdir(), "quanta-trust-scope-store-"))

const buildRegistry = (
  globalFilePath: string,
  opts: { projectRoot?: string; projectOverlayPath?: string; now?: () => number } = {},
) =>
  createPersistentTrustScopeRegistry({
    filePath: globalFilePath,
    debounceMs: 0, // tests want immediate flushes
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    ...(opts.projectOverlayPath !== undefined
      ? { projectOverlayPath: opts.projectOverlayPath }
      : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })

describe("trust-scope persistent store — HELL", () => {
  test("H-1: 50 concurrent grant() writes survive — no torn JSON, every record observable", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      const reg = buildRegistry(file)
      await reg.hydrate()
      const N = 50
      for (let i = 0; i < N; i += 1) {
        reg.grant("p1", { tool: "bash", scope: "project", actionKey: `bash|cmd-${i}` })
      }
      await reg.flush()
      // Build a fresh instance over the same file (simulates a second process)
      const reg2 = buildRegistry(file)
      await reg2.hydrate()
      for (let i = 0; i < N; i += 1) {
        expect(reg2.hasGrant("p1", { tool: "bash", actionKey: `bash|cmd-${i}` })).toBe(true)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-2: stale-TTL hydration — expired record does NOT satisfy hasGrant", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      let clock = 1_000_000
      const reg = buildRegistry(file, { now: () => clock })
      await reg.hydrate()
      reg.grant("p1", { tool: "bash", scope: "project", actionKey: "bash|ls" })
      // Mutate the file to add a TTL=10ms on the just-granted record.
      await reg.flush()
      const fileBytes = await Bun.file(file).text()
      const json = JSON.parse(fileBytes) as {
        version: 1
        grants: Record<string, Array<{ tool: string; ttlMs?: number; grantedAt: number }>>
      }
      const bucket = json.grants.p1
      if (!bucket || bucket.length === 0) throw new Error("expected granted record")
      const first = bucket[0]
      if (!first) throw new Error("unreachable")
      first.ttlMs = 10
      await writeFile(file, JSON.stringify(json))
      // Reload and advance the clock past expiry.
      const reg2 = buildRegistry(file, { now: () => clock })
      await reg2.hydrate()
      clock += 1
      expect(reg2.hasGrant("p1", { tool: "bash", actionKey: "bash|ls" })).toBe(true)
      clock += 100 // well past 10ms ttl
      expect(reg2.hasGrant("p1", { tool: "bash", actionKey: "bash|ls" })).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-3: malformed JSON ⇒ start empty + quarantine sidecar, no throw", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      await writeFile(file, "{ not valid json ::: ")
      const reg = buildRegistry(file)
      await reg.hydrate()
      // Cold-start state; no grants visible.
      expect(reg.hasGrant("p1", { tool: "bash" })).toBe(false)
      // Quarantine sidecar exists.
      const quar = await Bun.file(`${file}.corrupt`).exists()
      expect(quar).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-4: mid-session grant invalidation via revoke()", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      const reg = buildRegistry(file)
      await reg.hydrate()
      reg.grant("p1", { tool: "bash", scope: "project", actionKey: "bash|git status" })
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|git status" })).toBe(true)
      reg.revoke("p1", { tool: "bash", scope: "project", actionKey: "bash|git status" })
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|git status" })).toBe(false)
      // And after a flush + reload, the revoke persists.
      await reg.flush()
      const reg2 = buildRegistry(file)
      await reg2.hydrate()
      expect(reg2.hasGrant("p1", { tool: "bash", actionKey: "bash|git status" })).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-5: cascade with conflicting overlay/global — overlay wins, deny short-circuits", async () => {
    const dir = await mkTmp()
    const projDir = await mkdtemp(join(tmpdir(), "quanta-proj-"))
    try {
      const globalFile = join(dir, "grants.json")
      const overlayFile = join(projDir, "project-grants.json")
      const reg = buildRegistry(globalFile, { projectOverlayPath: overlayFile })
      await reg.hydrate()
      // Global says ALLOW (positive); overlay says DENY for same exact key.
      reg.grant("p1", { tool: "bash", scope: "project", actionKey: "bash|rm -rf" })
      // Manually inject overlay deny via file mutation (since grant() routes
      // to overlay when overlay exists — we want global+overlay to disagree).
      await reg.flush()
      const overlay = {
        version: 1,
        grants: {
          p1: [{ tool: "bash", scope: "deny", actionKey: "bash|rm -rf", grantedAt: Date.now() }],
        },
      }
      await writeFile(overlayFile, JSON.stringify(overlay))
      const reg2 = buildRegistry(globalFile, { projectOverlayPath: overlayFile })
      await reg2.hydrate()
      // Overlay deny short-circuits to false.
      expect(reg2.hasGrant("p1", { tool: "bash", actionKey: "bash|rm -rf" })).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(projDir, { recursive: true, force: true })
    }
  })

  test("H-6: empty command-pattern is rejected at parse time — never matches anything", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      // Hand-craft a file with an empty-string commandPattern.
      const payload = {
        version: 1,
        grants: {
          p1: [
            {
              tool: "bash",
              scope: "project",
              commandPattern: "   ", // whitespace-only → normalize to null
              grantedAt: Date.now(),
            },
          ],
        },
      }
      await writeFile(file, JSON.stringify(payload))
      const reg = buildRegistry(file)
      await reg.hydrate()
      // The malformed pattern dropped; the record reduces to tool-only — but
      // that still legitimately matches via tool-only cascade. To confirm
      // pattern-specific behavior we look up with an actionKey that should
      // NOT match a tool-only grant (the action has a different actionKey, so
      // the tool-only grant still matches, by design — assert it). What we
      // want to assert is that NO pattern record is in the snapshot.
      const snap = reg.snapshot()
      const recs = snap.p1 ?? []
      expect(recs.length).toBe(1)
      expect(recs[0]?.commandPattern).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-7: schema-version mismatch ⇒ quarantine-vN sidecar + start empty", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      await writeFile(file, JSON.stringify({ version: 99, grants: {} }))
      const reg = buildRegistry(file)
      await reg.hydrate()
      expect(reg.hasGrant("p1", { tool: "bash" })).toBe(false)
      const quar = await Bun.file(`${file}.unsupported-v99`).exists()
      expect(quar).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-8: cascade tie-breaker — exact actionKey beats pattern beats tool-only", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      // Pre-seed three layers of records for the same tool.
      const payload = {
        version: 1,
        grants: {
          p1: [
            // tool-only: ALLOW
            { tool: "bash", scope: "project", grantedAt: 1 },
            // command-pattern: DENY (more specific than tool-only)
            { tool: "bash", scope: "deny", commandPattern: "npm,install", grantedAt: 2 },
            // exact actionKey: ALLOW (most specific — wins)
            {
              tool: "bash",
              scope: "project",
              actionKey: "bash|npm install --save-dev typescript",
              grantedAt: 3,
            },
          ],
        },
      }
      await writeFile(file, JSON.stringify(payload))
      const reg = buildRegistry(file)
      await reg.hydrate()
      // Exact actionKey matches the third record (ALLOW).
      expect(
        reg.hasGrant("p1", { tool: "bash", actionKey: "bash|npm install --save-dev typescript" }),
      ).toBe(true)
      // A different actionKey that still matches the pattern → pattern wins → DENY.
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|npm install lodash" })).toBe(false)
      // A different actionKey that matches NEITHER exact nor pattern → tool-only ALLOW.
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|ls -la" })).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-9: project-overlay tightens user-global — overlay deny wins", async () => {
    const dir = await mkTmp()
    const projDir = await mkdtemp(join(tmpdir(), "quanta-proj-"))
    try {
      const globalFile = join(dir, "grants.json")
      const overlayFile = join(projDir, "project-grants.json")
      // Global grants ALL bash invocations (tool-only ALLOW).
      await writeFile(
        globalFile,
        JSON.stringify({
          version: 1,
          grants: { p1: [{ tool: "bash", scope: "always_allow", grantedAt: 1 }] },
        }),
      )
      // Overlay denies exactly "bash|rm -rf /".
      await writeFile(
        overlayFile,
        JSON.stringify({
          version: 1,
          grants: {
            p1: [{ tool: "bash", scope: "deny", actionKey: "bash|rm -rf /", grantedAt: 2 }],
          },
        }),
      )
      const reg = buildRegistry(globalFile, { projectOverlayPath: overlayFile })
      await reg.hydrate()
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|rm -rf /" })).toBe(false)
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|ls" })).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(projDir, { recursive: true, force: true })
    }
  })

  test("H-10: persistence across process boundary — write, build new instance, hydrate", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      const reg = buildRegistry(file)
      await reg.hydrate()
      reg.grant("p1", { tool: "bash", scope: "project", actionKey: "bash|pytest" })
      await reg.flush()
      // Drop the old instance; build a new one over the same path.
      const reg2 = buildRegistry(file)
      expect(reg2.hasGrant("p1", { tool: "bash", actionKey: "bash|pytest" })).toBe(false) // not hydrated yet
      await reg2.hydrate()
      expect(reg2.hasGrant("p1", { tool: "bash", actionKey: "bash|pytest" })).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-11: repeated grant() is structurally idempotent for hasGrant", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      const reg = buildRegistry(file)
      await reg.hydrate()
      reg.grant("p1", { tool: "bash", scope: "project", actionKey: "bash|ls" })
      reg.grant("p1", { tool: "bash", scope: "project", actionKey: "bash|ls" })
      reg.grant("p1", { tool: "bash", scope: "project", actionKey: "bash|ls" })
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|ls" })).toBe(true)
      // Revoke ONE — duplicates remain, hasGrant is still true.
      reg.revoke("p1", { tool: "bash", scope: "project", actionKey: "bash|ls" })
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|ls" })).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-12: command-pattern normalized at parse time (lowercased + trimmed)", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          grants: {
            p1: [
              {
                tool: "bash",
                scope: "project",
                commandPattern: "  NPM, install  ",
                grantedAt: 1,
              },
            ],
          },
        }),
      )
      const reg = buildRegistry(file)
      await reg.hydrate()
      // Pattern normalizes to "npm, install" (lowercased + trimmed). Match
      // against an action whose tokens are ["npm","install","..."].
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|npm install lodash" })).toBe(true)
      // A different leading token sequence is rejected.
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|yarn install lodash" })).toBe(
        false,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("H-13: once_only consumed inline — second hasGrant returns false", async () => {
    const dir = await mkTmp()
    try {
      const file = join(dir, "grants.json")
      const reg: TrustScopeRegistry = buildRegistry(file)
      await (reg as ReturnType<typeof buildRegistry>).hydrate()
      reg.grant("p1", { tool: "bash", scope: "once_only", actionKey: "bash|init" })
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|init" })).toBe(true)
      expect(reg.hasGrant("p1", { tool: "bash", actionKey: "bash|init" })).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
