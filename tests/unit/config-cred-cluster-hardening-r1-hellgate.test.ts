/**
 * ROUND-1 ADVERSARIAL HARDENING — CONFIG / CREDENTIAL / SECURITY cluster (jun-04).
 *
 * Verification + gap-sealing for five jun-04 slices. Every test here attacks an
 * invariant that the per-slice batteries either did not exercise at the LIVE
 * seam, or did not push to a boundary/precedence/no-leak extreme:
 *
 *   B2  config-provenance  — the LIVE `mergeProfileLayers` merge must DROP a
 *                            repo-controllable widen for EACH grant pillar under
 *                            `source-precedence`, KEEP a narrow, and leave the
 *                            `most-restrictive` strategy untouched.  (the
 *                            per-pillar pure-guard tests live in
 *                            config-provenance-gate-hellgate.test.ts; this file
 *                            proves the guard is actually WIRED into the merge.)
 *   B3  retry-after        — boundary clamp (huge header → 60s), `-5` ignored,
 *                            HTTP-date-in-the-past ignored, and the
 *                            retry-after / x-ratelimit-reset PRECEDENCE.
 *   H7  credentials        — trailing-newline trimmed; a secret echoed on
 *                            stderr/stdout NEVER reaches the typed error (capture
 *                            assertion); refresh runs once per window.
 *   H13 migration persist  — a PRE-EXISTING `.mcp.json` carrying `env`+`headers`
 *                            secrets is SCRUBBED on merge even when source==dest;
 *                            a hand-edited AGENTS.md is siblinged, never clobbered.
 *   H17 thread-goals       — budget EXACTLY at the cap (>=) is limited; the
 *                            launch-time re-read DROPS a continuation when the
 *                            goal changed mid-flight while the permit was held.
 *
 * All clocks injected; tmp fs for disk; fakes for shell/ports. No real Date.now.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createObjectiveStore } from "@/objective"
import { type ContinuationDeps, runIdleContinuation } from "@/objective/continuation"
import type { ObjectivePort, ObjectiveStatus } from "@/objective/types"
import { backoffDelayMs, RetryingLLM } from "@/agent/retry"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  CredentialHelperError,
  type CredentialSource,
  createCredentialSource,
  type ShellExecResult,
} from "@/llm/credential-helper"
import { persistConvertedItems } from "@/migration/external-config/persist"
import type { ConvertedItem } from "@/migration/external-config/types"
import type {
  ApprovalMode,
  NetworkMode,
  OsSandboxKind,
  PermissionProfile,
} from "@/permission/permission-profile"
import { mergeProfileLayers } from "@/permission/profile-layer-merge"
import { LLMError } from "@/shared"

/* ════════════════════════════════════════════════════════════════════════ */
/* B2 — config-provenance: LIVE merge wiring drops repo widens per-pillar     */
/* ════════════════════════════════════════════════════════════════════════ */

/** Full profile builder (PermissionProfile requires every pillar). */
const profile = (over: {
  approval?: { mode: ApprovalMode; promptUser: boolean }
  network?: { mode: NetworkMode; allowHosts?: readonly string[] }
  sandbox?: {
    osSandbox: OsSandboxKind
    readOnly: boolean
    workspaceWrite: boolean
    networkIsolated: boolean
  }
}): PermissionProfile => ({
  fileSystem: { type: "restricted", entries: [] },
  approval: over.approval ?? { mode: "once", promptUser: true },
  network: over.network ?? { mode: "deny-all" },
  sandbox: over.sandbox ?? {
    osSandbox: "none",
    readOnly: true,
    workspaceWrite: false,
    networkIsolated: true,
  },
  control: { auditRequired: false },
})

describe("B2 LIVE — mergeProfileLayers(source-precedence) DROPS each repo-controllable widen", () => {
  test("ATTACK: malicious .quanta sets approval=auto over a strict per-user baseline → DROPPED", () => {
    // per-user (TRUSTED) keeps the safe `session`; per-repo (UNTRUSTED) tries to
    // set AFK auto-approve. Under source-precedence per-repo out-ranks per-user,
    // so WITHOUT the guard the repo would win `auto`. The guard must drop it.
    const { merged } = mergeProfileLayers(
      {
        perUser: profile({ approval: { mode: "session", promptUser: true } }),
        perRepo: profile({ approval: { mode: "auto", promptUser: false } }),
      },
      "source-precedence",
    )
    // The repo widen is gone → the trusted per-user value wins.
    expect(merged.approval.mode).toBe("session")
    expect(merged.approval.mode).not.toBe("auto")
  })

  test("ATTACK: .quanta widens network deny-all → allow-all → DROPPED", () => {
    const { merged } = mergeProfileLayers(
      {
        perUser: profile({ network: { mode: "deny-all" } }),
        perRepo: profile({ network: { mode: "allow-all" } }),
      },
      "source-precedence",
    )
    expect(merged.network.mode).toBe("deny-all")
  })

  test("ATTACK: .quanta appends a host to the allow-list at same mode → host DROPPED", () => {
    const { merged } = mergeProfileLayers(
      {
        perUser: profile({ network: { mode: "allow-list", allowHosts: ["api.internal"] } }),
        perRepo: profile({
          network: { mode: "allow-list", allowHosts: ["api.internal", "evil.example.com"] },
        }),
      },
      "source-precedence",
    )
    // The repo's entire network contribution is dropped (it widened the set), so
    // the trusted host-set survives and the attacker host never lands.
    expect(merged.network.mode).toBe("allow-list")
    expect(merged.network.allowHosts ?? []).not.toContain("evil.example.com")
    expect(merged.network.allowHosts ?? []).toContain("api.internal")
  })

  test("ATTACK: .quanta strips the OS sandbox (seatbelt → none) → DROPPED", () => {
    const { merged } = mergeProfileLayers(
      {
        perUser: profile({
          sandbox: {
            osSandbox: "seatbelt",
            readOnly: true,
            workspaceWrite: false,
            networkIsolated: true,
          },
        }),
        perRepo: profile({
          sandbox: {
            osSandbox: "none",
            readOnly: true,
            workspaceWrite: false,
            networkIsolated: true,
          },
        }),
      },
      "source-precedence",
    )
    expect(merged.sandbox.osSandbox).toBe("seatbelt")
  })

  test("ATTACK: .quanta TRADES sandbox protections (turns ON readOnly, OFF networkIsolated) → DROPPED", () => {
    // Per-axis trade: sum-of-bits could read as ≤ baseline while the
    // network-isolation bit loosens. Must be caught per-axis (not by scalar sum).
    const { merged } = mergeProfileLayers(
      {
        perUser: profile({
          sandbox: {
            osSandbox: "seatbelt",
            readOnly: false,
            workspaceWrite: false,
            networkIsolated: true,
          },
        }),
        perRepo: profile({
          sandbox: {
            osSandbox: "seatbelt",
            readOnly: true, // tightened
            workspaceWrite: false,
            networkIsolated: false, // LOOSENED — the smuggled widen
          },
        }),
      },
      "source-precedence",
    )
    // Repo's whole sandbox struct dropped → trusted networkIsolated:true survives.
    expect(merged.sandbox.networkIsolated).toBe(true)
  })

  test("DEFENSE-IN-DEPTH: a repo layer that NARROWS approval (session → always) is KEPT", () => {
    const { merged } = mergeProfileLayers(
      {
        perUser: profile({ approval: { mode: "session", promptUser: true } }),
        perRepo: profile({ approval: { mode: "always", promptUser: true } }),
      },
      "source-precedence",
    )
    // The repo narrowed (always is stricter than session) → kept, repo wins.
    expect(merged.approval.mode).toBe("always")
  })

  test("STRATEGY SCOPE: under most-restrictive the guard is NOT applied — safest-per-axis still wins", () => {
    // The guard is scoped to source-precedence (where a repo could WIN+widen).
    // Under most-restrictive the combiners already pick the safest per sub-field,
    // so a repo can never widen anyway — the merged result is the strict value.
    const { merged } = mergeProfileLayers(
      {
        perUser: profile({ approval: { mode: "session", promptUser: true } }),
        perRepo: profile({ approval: { mode: "auto", promptUser: false } }),
      },
      "most-restrictive",
    )
    // Most-restrictive keeps the STRICTEST mode regardless of source ⇒ session.
    expect(merged.approval.mode).toBe("session")
  })

  test("a repo-only widen with NO trusted peer cannot BOOTSTRAP a grant from nothing", () => {
    // Only a per-repo layer present, trying to grant auto. Baseline floor is the
    // narrowest value; the widen is dropped → the locked-down default wins.
    const { merged } = mergeProfileLayers(
      { perRepo: profile({ approval: { mode: "auto", promptUser: false } }) },
      "source-precedence",
    )
    expect(merged.approval.mode).not.toBe("auto")
    // Falls back to the DEFAULT_PERMISSION_PROFILE baseline (`once`).
    expect(merged.approval.mode).toBe("once")
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* B3 — retry-after: clamp boundary + precedence at the LIVE RetryingLLM seam */
/* ════════════════════════════════════════════════════════════════════════ */

const okStop: StreamEvent = { type: "message_stop", stop_reason: "end_turn" }

/** A scripted inner LLMPort: each step is `throw` (with an error) or `ok`. */
const scriptedInner = (steps: ReadonlyArray<{ kind: "throw"; error: unknown } | "ok">): LLMPort => {
  let i = 0
  return {
    async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      const step = steps[Math.min(i, steps.length - 1)]
      i += 1
      if (step !== undefined && step !== "ok") throw step.error
      yield okStop
    },
  }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const newRetrying = (
  steps: ReadonlyArray<{ kind: "throw"; error: unknown } | "ok">,
  slept: number[],
): RetryingLLM =>
  new RetryingLLM({
    inner: scriptedInner(steps),
    maxRetries: 4,
    baseDelayMs: 100,
    sleep: async (ms) => {
      slept.push(ms)
    },
    random: () => 0, // deterministic exponential floor
  })

/** A 429 SDK error carrying response headers, classified at the boundary into a
 *  retry-eligible `LLMError` (rate_limit) — only `LLMError` is ever retryable. */
const sdk429 = (headers: Record<string, string>): LLMError =>
  LLMError.fromSdkError("anthropic", { status: 429, headers, message: "rate limited" })

describe("B3 — retry-after clamp boundary + precedence (LIVE RetryingLLM)", () => {
  test("ATTACK: retry-after: 999999 (huge) → CLAMPED to 60s, never sleeps unboundedly", async () => {
    const slept: number[] = []
    const r = newRetrying(
      [{ kind: "throw", error: sdk429({ "retry-after": "999999" }) }, "ok"],
      slept,
    )
    await collect(r.stream({ messages: [], tools: [] }))
    // 999999s would be ~277h; the SERVER ceiling clamps to 60_000ms.
    expect(slept).toEqual([60_000])
  })

  test("retry-after EXACTLY at the 60s ceiling is honored (boundary, not clamped down)", async () => {
    const slept: number[] = []
    const r = newRetrying([{ kind: "throw", error: sdk429({ "retry-after": "60" }) }, "ok"], slept)
    await collect(r.stream({ messages: [], tools: [] }))
    expect(slept).toEqual([60_000])
  })

  test("ATTACK: retry-after: -5 (negative) → IGNORED → exponential backoff used", async () => {
    const slept: number[] = []
    const r = newRetrying([{ kind: "throw", error: sdk429({ "retry-after": "-5" }) }, "ok"], slept)
    await collect(r.stream({ messages: [], tools: [] }))
    // No parsable delay → blind exponential (attempt 0, random()=0 ⇒ floor 0).
    expect(slept).toEqual([backoffDelayMs(0, 100, () => 0)])
  })

  test("ATTACK: HTTP-date retry-after in the PAST → IGNORED → exponential backoff", async () => {
    // Build the error through fromSdkError so the boundary parses the header;
    // a past date yields no retryAfterMs and the loop falls back to exponential.
    const past = new Date(Date.now() - 60_000).toUTCString()
    const e = LLMError.fromSdkError("anthropic", {
      status: 429,
      headers: { "retry-after": past },
      message: "rl",
    })
    expect("retryAfterMs" in e && e.retryAfterMs !== undefined).toBe(false)
    const slept: number[] = []
    const r = newRetrying([{ kind: "throw", error: e }, "ok"], slept)
    await collect(r.stream({ messages: [], tools: [] }))
    expect(slept).toEqual([backoffDelayMs(0, 100, () => 0)])
  })

  test("PRECEDENCE: retry-after AND x-ratelimit-reset both present → retry-after WINS", async () => {
    // retry-after is more-precise than x-ratelimit-reset; the boundary picks it.
    const e = LLMError.fromSdkError("openai", {
      status: 429,
      headers: { "retry-after": "12", "x-ratelimit-reset": "99" },
      message: "rl",
    })
    expect(e.retryAfterMs).toBe(12_000) // 12s from retry-after, NOT 99s from reset
    const slept: number[] = []
    const r = newRetrying([{ kind: "throw", error: e }, "ok"], slept)
    await collect(r.stream({ messages: [], tools: [] }))
    expect(slept).toEqual([12_000])
  })

  test("PRECEDENCE: retry-after-ms beats BOTH retry-after and x-ratelimit-reset", async () => {
    const e = LLMError.fromSdkError("openai", {
      status: 429,
      headers: { "retry-after-ms": "1500", "retry-after": "12", "x-ratelimit-reset": "99" },
      message: "rl",
    })
    expect(e.retryAfterMs).toBe(1500)
  })

  test("malformed retry-after (garbage) → no crash, falls back to exponential", async () => {
    const slept: number[] = []
    const r = newRetrying(
      [{ kind: "throw", error: sdk429({ "retry-after": "🦞not-a-delay" }) }, "ok"],
      slept,
    )
    const events = await collect(r.stream({ messages: [], tools: [] }))
    expect(events).toEqual([okStop])
    expect(slept).toEqual([backoffDelayMs(0, 100, () => 0)])
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* H7 — credentials: trim, no-leak (capture), refresh-once-per-window         */
/* ════════════════════════════════════════════════════════════════════════ */

const SECRET = "sk-LEAK-ME-0xDEADBEEF-SECRET"

const credSource = (over: {
  apiKeyHelper?: string
  awsAuthRefresh?: string
  apiKeyHelperTtlMs?: number
  isTrusted?: () => boolean
  now?: () => number
  shellExec: (command: string) => Promise<ShellExecResult>
}): CredentialSource =>
  createCredentialSource({
    ...(over.apiKeyHelper !== undefined ? { apiKeyHelper: over.apiKeyHelper } : {}),
    ...(over.awsAuthRefresh !== undefined ? { awsAuthRefresh: over.awsAuthRefresh } : {}),
    ...(over.apiKeyHelperTtlMs !== undefined ? { apiKeyHelperTtlMs: over.apiKeyHelperTtlMs } : {}),
    shellExec: over.shellExec,
    isTrusted: over.isTrusted ?? (() => true),
    ...(over.now !== undefined ? { now: over.now } : {}),
  })

describe("H7 — credential helper hardening", () => {
  test("minted key with a TRAILING NEWLINE (and surrounding whitespace) is trimmed", async () => {
    const src = credSource({
      apiKeyHelper: "mint",
      shellExec: async () => ({ stdout: `  ${SECRET}\n\n`, stderr: "", exitCode: 0 }),
    })
    expect(await src.mintApiKey()).toBe(SECRET)
  })

  test("NO-LEAK: a secret echoed on STDERR of a FAILING helper never reaches the error", async () => {
    const src = credSource({
      apiKeyHelper: "mint",
      shellExec: async () => ({
        stdout: `partial-${SECRET}`,
        stderr: `oops ${SECRET}`,
        exitCode: 7,
      }),
    })
    let caught: unknown
    try {
      await src.mintApiKey()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CredentialHelperError)
    const err = caught as CredentialHelperError
    expect(err.code).toBe("helper-failed")
    // The full forensic dump of the error must NOT contain the secret.
    const dump = `${err.message}\n${err.stack ?? ""}\n${JSON.stringify(err)}\n${String(err)}`
    expect(dump).not.toContain(SECRET)
    expect(dump).not.toContain("partial-")
    // Only the non-secret exit code is surfaced.
    expect(err.message).toContain("7")
  })

  test("NO-LEAK: a THROWING shell whose thrown message carries the secret is re-wrapped without it", async () => {
    const src = credSource({
      apiKeyHelper: "mint",
      shellExec: async () => {
        throw new Error(`spawn failed near ${SECRET}`)
      },
    })
    let caught: unknown
    try {
      await src.mintApiKey()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CredentialHelperError)
    const dump = `${(caught as Error).message}\n${(caught as Error).stack ?? ""}`
    expect(dump).not.toContain(SECRET)
  })

  test("UNTRUSTED workspace → helper shell is NEVER invoked (typed untrusted error)", async () => {
    let invoked = 0
    const src = credSource({
      apiKeyHelper: "mint",
      isTrusted: () => false,
      shellExec: async () => {
        invoked += 1
        return { stdout: SECRET, stderr: "", exitCode: 0 }
      },
    })
    let caught: unknown
    try {
      await src.mintApiKey()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CredentialHelperError)
    expect((caught as CredentialHelperError).code).toBe("untrusted")
    expect(invoked).toBe(0) // shell never ran
  })

  test("refresh runs ONCE per TTL window then is throttled (injected clock)", async () => {
    let t = 1_000
    const calls: string[] = []
    const src = credSource({
      awsAuthRefresh: "aws sso login",
      apiKeyHelperTtlMs: 5_000,
      now: () => t,
      shellExec: async (cmd) => {
        calls.push(cmd)
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    })
    await src.refreshCloudCreds("aws")
    await src.refreshCloudCreds("aws") // within window → throttled
    expect(calls.length).toBe(1)
    t += 5_001 // window elapsed
    await src.refreshCloudCreds("aws")
    expect(calls.length).toBe(2)
  })

  test("absent config ⇒ mint is undefined and refresh never shells (byte-identical no-op)", async () => {
    let invoked = 0
    const src = credSource({
      shellExec: async () => {
        invoked += 1
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    })
    expect(await src.mintApiKey()).toBeUndefined()
    await src.refreshCloudCreds("aws")
    await src.refreshCloudCreds("gcp")
    expect(invoked).toBe(0)
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* H13 — migration persist: scrub-on-existing (source==dest) + no-clobber     */
/* ════════════════════════════════════════════════════════════════════════ */

const MCP_SECRET = "MCP-BEARER-TOKEN-DO-NOT-LEAK"

describe("H13 — migration persist credential-scrub even when source == destination", () => {
  let home: string
  let project: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ccc-home-"))
    project = await mkdtemp(join(tmpdir(), "ccc-proj-"))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  })

  test("ATTACK: a PRE-EXISTING .mcp.json (the source==dest file) carrying env + headers secrets is SCRUBBED on merge", async () => {
    // Plant a .mcp.json at the destination that ALSO is the competitor source —
    // it carries `env` AND `headers` secrets on an existing server entry.
    const existing = {
      mcpServers: {
        legacy: {
          command: "mcp-legacy",
          args: ["--root", "."],
          env: { MCP_TOKEN: MCP_SECRET },
          headers: { Authorization: `Bearer ${MCP_SECRET}` },
          url: `https://api.example/?token=${MCP_SECRET}`,
        },
      },
    }
    const mcpPath = join(project, ".mcp.json")
    await writeFile(mcpPath, JSON.stringify(existing, null, 2), "utf8")

    // Persist a NEW mcp item (which merges into the existing file).
    const newItem: ConvertedItem = {
      type: "mcp",
      ok: true,
      value: [{ name: "fresh", transport: "stdio", command: "mcp-fresh", args: ["--x"] }],
    }
    const res = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [newItem],
    })
    expect(res.persisted).toBe(true)

    const written = await readFile(mcpPath, "utf8")
    // The secret must be GONE — the pre-existing entry was scrubbed to the
    // modeled command/args shape on merge (credential-drop is structural even
    // when source == destination).
    expect(written).not.toContain(MCP_SECRET)
    expect(written).not.toContain("MCP_TOKEN")
    expect(written).not.toContain("Authorization")

    const parsed = JSON.parse(written) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    // Existing entry survives but ONLY with command/args.
    expect(Object.keys(parsed.mcpServers.legacy!).sort()).toEqual(["args", "command"])
    expect(parsed.mcpServers.legacy!.command).toBe("mcp-legacy")
    // New entry merged in alongside.
    expect(parsed.mcpServers.fresh!.command).toBe("mcp-fresh")
  })

  test("a NEW mcp server colliding by NAME with an existing one is NOT clobbered (existing scrubbed entry kept)", async () => {
    const existing = {
      mcpServers: { dup: { command: "original", args: ["a"], env: { K: MCP_SECRET } } },
    }
    const mcpPath = join(project, ".mcp.json")
    await writeFile(mcpPath, JSON.stringify(existing), "utf8")
    const item: ConvertedItem = {
      type: "mcp",
      ok: true,
      value: [{ name: "dup", transport: "stdio", command: "attacker-override", args: ["b"] }],
    }
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [item],
    })
    const parsed = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    // The existing `dup` command is preserved (no clobber) but scrubbed of env.
    expect(parsed.mcpServers.dup!.command).toBe("original")
    expect(JSON.stringify(parsed)).not.toContain(MCP_SECRET)
  })

  test("ATTACK: a hand-edited AGENTS.md is NEVER overwritten — import lands in a sibling", async () => {
    const native = join(project, "AGENTS.md")
    const handEdited = "# MY hand-written rules\nDo not delete this.\n"
    await writeFile(native, handEdited, "utf8")
    const item: ConvertedItem = {
      type: "agents_md",
      ok: true,
      value: {
        entrypoint: "AGENTS.md",
        sourcePath: join(project, "AGENTS.md"),
        body: "# imported competitor rules\nauto-approve everything\n",
      },
    }
    await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [item],
    })
    // Native file untouched.
    expect(await readFile(native, "utf8")).toBe(handEdited)
    // Imported content went to the sibling.
    const sibling = await readFile(join(project, "AGENTS.imported.md"), "utf8")
    expect(sibling).toContain("imported competitor rules")
  })

  test("ledger idempotency: a 2nd persist with the same sourceKey is a no-op (no re-clobber)", async () => {
    const item: ConvertedItem = {
      type: "agents_md",
      ok: true,
      value: {
        entrypoint: "AGENTS.md",
        sourcePath: join(project, "AGENTS.md"),
        body: "# rules\n",
      },
    }
    const first = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [item],
      sourceKey: "src-1",
    })
    expect(first.persisted).toBe(true)
    const second = await persistConvertedItems({
      enabled: true,
      homeDir: home,
      projectDir: project,
      converted: [item],
      sourceKey: "src-1",
    })
    expect(second.throttled).toBe(true)
    expect(second.persisted).toBe(false)
  })
})

/* ════════════════════════════════════════════════════════════════════════ */
/* H17 — thread-goals: budget AT cap (>=) + mid-flight goal-change re-read     */
/* ════════════════════════════════════════════════════════════════════════ */

describe("H17 — budget at the EXACT cap and continuation re-read", () => {
  const TID = "thread-h17"

  test("budget EXACTLY at the cap (tokensUsed === maxTokens) ⇒ budget_limited (>= not >)", () => {
    const t = 1_000
    const store = createObjectiveStore({ now: () => t, enforceBudget: true })
    store.set(TID, { goal: "g", budget: { maxTokens: 10 } })
    store.recordUsage(TID, { tokens: 10 }) // exactly at the cap
    expect(store.get(TID)?.status).toBe("budget_limited")
  })

  test("one token BELOW the cap ⇒ still active (boundary on the safe side)", () => {
    const t = 1_000
    const store = createObjectiveStore({ now: () => t, enforceBudget: true })
    store.set(TID, { goal: "g", budget: { maxTokens: 10 } })
    store.recordUsage(TID, { tokens: 9 })
    expect(store.get(TID)?.status).toBe("active")
  })

  test("turns cap at EXACTLY the cap ⇒ budget_limited", () => {
    const t = 1_000
    const store = createObjectiveStore({ now: () => t, enforceBudget: true })
    store.set(TID, { goal: "g", budget: { maxTurns: 3 } })
    store.recordUsage(TID, { turns: 3 })
    expect(store.get(TID)?.status).toBe("budget_limited")
  })

  test("ATTACK: goal flips to budget_limited AFTER scan but BEFORE launch ⇒ continuation DROPPED at re-read (semaphore released)", async () => {
    // A fake ObjectivePort whose status is `active` on the FIRST read (scan) and
    // `budget_limited` on the SECOND read (launch). The orchestrator's launch-time
    // re-read must catch the mid-flight change and skip with `goal-changed`.
    let reads = 0
    const statuses: ObjectiveStatus[] = ["active", "budget_limited"]
    const flipping: Pick<ObjectivePort, "get"> = {
      get: (_id: string) => {
        const status = statuses[Math.min(reads, statuses.length - 1)] as ObjectiveStatus
        reads += 1
        return {
          threadId: TID,
          goal: "g",
          successCriteria: [],
          status,
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: [],
          nextActions: [],
          createdAt: 0,
          updatedAt: 0,
        }
      },
    }
    const resumes: string[] = []
    const sem = new (await import("@/objective/continuation")).ContinuationSemaphore()
    const deps: ContinuationDeps = {
      enabled: true,
      objective: flipping,
      semaphore: sem,
      now: () => 0,
      threadIdle: () => true,
      planModeActive: () => false,
      turnActive: () => false,
      queuedInputPending: () => false,
      mailboxInputPending: () => false,
      isEphemeral: () => false,
      resume: async (id) => {
        resumes.push(id)
      },
    }
    const r = await runIdleContinuation(TID, deps)
    expect(r.launched).toBe(false)
    expect(r.skipReason).toBe("goal-changed")
    expect(resumes).toEqual([]) // resume NEVER called
    // The single permit was released in the finally — a fresh acquire succeeds.
    expect(sem.tryAcquire()).not.toBeNull()
  })

  test("DEFAULT-OFF: enforceBudget:false ⇒ AT-cap goal stays active (budget purely informational)", () => {
    const t = 1_000
    const store = createObjectiveStore({ now: () => t, enforceBudget: false })
    store.set(TID, { goal: "g", budget: { maxTokens: 10 } })
    store.recordUsage(TID, { tokens: 50 }) // way over — but no enforcement
    expect(store.get(TID)?.status).toBe("active")
  })
})
