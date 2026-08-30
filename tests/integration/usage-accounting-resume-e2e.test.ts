/**
 * A6 e2e — the session's books survive the REAL persistence path.
 *
 * Not a codec unit test: this drives the shipped `persistTurn` feeder shape
 * (`usageAccountingSnapshot` on the SavePayload), the shipped
 * `saveSessionById`/`loadSessionById` store with its preserve-on-omit
 * discipline, and the hydrate a resume performs — against a HERMETIC session
 * root (never the developer's ~/.quanta; every temp dir is removed).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOutcome } from "@/agent"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import {
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageProvenance,
} from "@/observability/usage-accounting"
import { persistTurn, resolveResume } from "@/runner/orchestrate"
import {
  loadSessionById,
  type SessionMeta,
  type SessionRootProvider,
  saveSessionById,
} from "@/session"

const roots: string[] = []
const hermeticProvider = (): SessionRootProvider => {
  const root = mkdtempSync(join(tmpdir(), "quanta-a6-resume-"))
  roots.push(root)
  return { resolve: async () => root }
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const PROV: UsageProvenance = {
  sessionId: "sess-a6",
  agentId: "root",
  agentKind: "root",
  depth: 0,
}

const meta = (id: string): SessionMeta =>
  ({ id, title: "a6", createdAt: 1, lastTouched: 1, cwd: "/tmp", archived: false }) as SessionMeta

const spend = (acct: ReturnType<typeof createUsageAccounting>, inputTokens: number) => {
  const usage = normalizeUsage({ model: "claude-sonnet-4-6", inputTokens, outputTokens: 0 })
  acct.record({
    callId: acct.mintCallId(PROV),
    at: 1,
    usage,
    cost: priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION }),
    provenance: PROV,
  })
}

describe("A6 — real store round trip", () => {
  test("save → load → hydrate: prior totals + new spend stay continuous", async () => {
    const provider = hermeticProvider()
    const first = createUsageAccounting()
    spend(first, 1_000_000) // $3
    spend(first, 1_000_000) // $6 total

    // The shipped save path: the feeder's serialize rides the SavePayload.
    await saveSessionById(
      meta("a6-1"),
      { reason: "turn", turns: 1, messages: [], usageAccounting: first.serialize() },
      provider,
    )

    // The shipped resume path: load, hydrate BEFORE any model call, keep going.
    const saved = await loadSessionById("a6-1", provider)
    expect(saved?.usageAccounting).toBeDefined()
    const resumed = createUsageAccounting()
    expect(resumed.hydrate(saved?.usageAccounting ?? "")).toBe(true)
    expect(resumed.snapshot().totalUsd).toBeCloseTo(6, 9)
    spend(resumed, 1_000_000)
    expect(resumed.snapshot().totalUsd).toBeCloseTo(9, 9) // 이전 + 신규 연속
    expect(resumed.snapshot().calls).toBe(3)
  })

  test("preserve-on-omit: a plain transcript save never drops the books", async () => {
    const provider = hermeticProvider()
    const acct = createUsageAccounting()
    spend(acct, 1_000_000)
    await saveSessionById(
      meta("a6-2"),
      { reason: "turn", turns: 1, messages: [], usageAccounting: acct.serialize() },
      provider,
    )
    // The next save OMITS the field — crash markers and legacy paths do this.
    await saveSessionById(meta("a6-2"), { reason: "marker", turns: 1, messages: [] }, provider)
    const saved = await loadSessionById("a6-2", provider)
    const restored = createUsageAccounting()
    expect(restored.hydrate(saved?.usageAccounting ?? "")).toBe(true)
    expect(restored.snapshot().totalUsd).toBeCloseTo(3, 9)
  })

  test("corrupt on-disk books: resume lives, the loss is spoken", async () => {
    const provider = hermeticProvider()
    await saveSessionById(
      meta("a6-3"),
      { reason: "turn", turns: 1, messages: [], usageAccounting: "{ corrupt" },
      provider,
    )
    const saved = await loadSessionById("a6-3", provider)
    const resumed = createUsageAccounting()
    expect(resumed.hydrate(saved?.usageAccounting ?? "")).toBe(false)
    expect(resumed.snapshot().continuityLost).toBe(true)
    expect(resumed.snapshot().totalUsd).toBe(0)
    // …and the session keeps working: new spend still books.
    spend(resumed, 1_000_000)
    expect(resumed.snapshot().totalUsd).toBeCloseTo(3, 9)
  })
})

describe("A6 — the REAL --resume path (persistTurn feeder → resolveResume)", () => {
  test("prior totals ride the shipped auto-save and reopen continuous", async () => {
    // Hermetic sessions root; restored on exit so no other test inherits it.
    const dir = mkdtempSync(join(tmpdir(), "quanta-a6-real-resume-"))
    const priorEnv = process.env.QUANTA_SESSIONS_DIR
    process.env.QUANTA_SESSIONS_DIR = dir
    try {
      const acct = createUsageAccounting()
      spend(acct, 1_000_000)
      spend(acct, 1_000_000) // $6

      const idMeta = {
        id: "a6-real",
        title: "a6",
        cwd: dir,
        createdAt: 1_000,
        lastTouched: 1_000,
        archived: false,
      } as SessionMeta
      await saveSessionById(idMeta, { reason: "fresh", turns: 0, messages: [] })
      // THE production per-turn write, with the feeder the turn-runner supplies.
      await persistTurn({
        state: undefined,
        idMeta,
        sessionId: idMeta.id,
        messages: [],
        outcome: { reason: "completed", turns: 1, messages: [] } as AgentOutcome,
        usageAccountingSnapshot: () => acct.serialize(),
      })

      // THE production reopen (`quanta --resume a6-real`).
      const resolved = await resolveResume({
        resume: idMeta.id,
        newSession: false,
        title: undefined,
        cwd: dir,
        initialSessionId: "unused",
        slog: { info: () => undefined, warn: () => undefined } as never,
      })
      expect(resolved.usageAccounting).toBeDefined()

      const resumed = createUsageAccounting()
      expect(resumed.hydrate(resolved.usageAccounting ?? "")).toBe(true)
      expect(resumed.snapshot().totalUsd).toBeCloseTo(6, 9)
      spend(resumed, 1_000_000)
      expect(resumed.snapshot().totalUsd).toBeCloseTo(9, 9) // 이전 + 신규 연속
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (priorEnv === undefined) delete process.env.QUANTA_SESSIONS_DIR
      else process.env.QUANTA_SESSIONS_DIR = priorEnv
    }
  })
})
