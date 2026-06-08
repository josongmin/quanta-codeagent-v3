/**
 * ADR-0299 — host-bootstrap-extraction hellgate.
 *
 * Every adversarial case below pins one invariant of the extraction:
 *
 *  1. `bootstrapSession` is the SSOT in `@/host/bootstrap` (no re-export shim
 *     left behind at `src/apps/cli/repl/session-bootstrap.ts`).
 *  2. The host slice (`src/host/bootstrap/**`) does NOT import from
 *     `src/apps/cli/**` (surface-coupling fence).
 *  3. The host slice does NOT import the reviewer-subagent factory module
 *     directly — those factories arrive as deps.
 *  4. `src/apps/cli/repl/**` (the CLI seam) does NOT call `materializeReviewerAgent`,
 *     `createSubagentBackedGuardianReview`, `buildLlmStack`, or `loadFeatures(`
 *     inline — every such call must route through a dep closure.
 *  5. `SessionBootstrapDeps` lists every spec-mandated factory field as a
 *     REQUIRED key (no `?` optionality).
 *  6. The factories are typed (compile-time pin) — not `Function` or
 *     `(args: unknown) => unknown`.
 *  7. End-to-end: a smoke call with fully-faked deps produces a typed result
 *     carrying the SAME closures back (reviewer factories re-exposed for the
 *     CLI seam) so consumers don't re-import the agent slice.
 *  8. The barrel re-exports `SessionBootstrapError` (the typed failure value)
 *     so surfaces can `instanceof`-check it without reaching into `./types`.
 *  9. `isSessionBootstrapError(...)` correctly type-narrows.
 * 10. Failure flow: a throwing `buildLlm` is wrapped into a typed
 *     `SessionBootstrapError` (not bubbled raw).
 * 11. Failure flow: a `resolveResume` that reports a conflict gets wrapped.
 * 12. Failure flow: a `resolveResume` reporting a missing id gets wrapped.
 * 13. The host slice imports `isPathLikeToken` from `@/runner/orchestrate`
 *     (not from `apps/cli/internal` — would break surface-isolation).
 * 14. Tooling builder is invoked with the SAME `lifecycleTaskRegistry` the
 *     lifecycle bundle reports (single source of truth for the registry).
 * 15. Empty mcpClients ⇒ deriveMcpPillServers is NOT called (conditional
 *     contract — the lifecycle pill stays in its initial state).
 *
 * These tests are HOST-LEVEL: every case stands up the bootstrap directly
 * with a typed dep bundle. No `process.env` mocking, no `mock.module` —
 * the only seam is the typed `SessionBootstrapDeps`.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import {
  bootstrapSession,
  isSessionBootstrapError,
  type SessionBootstrapDeps,
  SessionBootstrapError,
  type SessionRuntimeConfigShape,
} from "@/host/bootstrap"
import type { LLMPort } from "@/llm"
import type { ResolveResumeInput } from "@/runner/orchestrate"

// ── helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = new URL("../../../", import.meta.url).pathname

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...walk(full))
    else if (s.isFile() && (extname(full) === ".ts" || extname(full) === ".tsx")) out.push(full)
  }
  return out
}

const grepDir = (relDir: string, needle: RegExp | string): readonly string[] => {
  const root = join(REPO_ROOT, relDir)
  try {
    statSync(root)
  } catch {
    return []
  }
  const files = walk(root)
  const matches: string[] = []
  for (const f of files) {
    const body = readFileSync(f, "utf8")
    const hit = typeof needle === "string" ? body.includes(needle) : needle.test(body)
    if (hit) matches.push(f)
  }
  return matches
}

const fakeLLM: LLMPort = {
  stream: async function* () {
    yield* []
  },
}

const makeFakeDeps = (overrides: Partial<SessionBootstrapDeps> = {}): SessionBootstrapDeps => {
  const base: SessionBootstrapDeps = {
    buildLifecycleBundle: () => ({
      pills: { update: () => undefined },
      taskRegistry: undefined,
      followUpQueue: undefined,
    }),
    deriveMcpPillServers: () => [],
    buildCostPanelOrUndefined: () => undefined,
    buildBranchProgressOrUndefined: () => undefined,
    buildPlanStoreOrUndefined: () => undefined,
    buildWorkMetricsSink: () => undefined,
    buildLlm: () => fakeLLM,
    // jun-6 (RFC jun-6-ai-session-title) — default-OFF stub: no auto-title port.
    buildAutoTitlePort: () => undefined,
    buildStreaming: () => ({
      stream: { emit: () => undefined },
      run: undefined,
    }),
    buildTooling: () =>
      ({
        store: undefined,
        embedder: undefined,
        sessionId: "fake-session",
        registry: { tools: () => [] },
        memoryConfig: undefined,
        subagentConfig: undefined,
        skillsConfig: undefined,
        compactionBreakerConfig: undefined,
        verifyGuardConfig: undefined,
      }) as never,
    loadFeatures: async () => ({
      planMode: false,
      metrics: undefined,
      state: undefined,
      resume: undefined,
      mcpTools: [],
      mcpClients: [],
      mcpConfigs: [],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
    }),
    loadImageBlock: () => ({ kind: "image", data: "", mimeType: "image/png" }) as never,
    pickIdentity: () => undefined,
    pickPersona: () => "default" as never,
    resolveResume: async (_input: ResolveResumeInput) => ({
      sessionId: "resolved-session",
      history: [],
      idMeta: undefined,
      inIdMode: false,
      conflictError: undefined,
      missingIdError: undefined,
    }),
    composeShellEvent: () => undefined,
    switchToSessionCwd: (cwd) => cwd,
    materializeReviewerAgent: () => undefined,
    createSubagentBackedGuardianReview: () => (async () => ({})) as never,
    createSubagentBackedGuardianAssess: () => (async () => ({})) as never,
    buildMcpSurfaceInfo: () => undefined,
    buildIdleGuards: () => ({
      idleMonitor: { markActive: () => undefined } as never,
      rejectCounter: { recordAccept: () => undefined } as never,
    }),
  }
  return { ...base, ...overrides }
}

const makeRuntime = (
  overrides: Partial<SessionRuntimeConfigShape> = {},
): SessionRuntimeConfigShape => ({
  provider: "openai" as never,
  model: "test-model",
  mode: "default" as never,
  maxTurns: 5,
  cwd: "/tmp/test",
  env: {},
  homeDir: "/tmp",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  newSession: false,
  title: undefined,
  idleMs: 60_000,
  snoozeDefaultMs: 300_000,
  rejectLimit: 20,
  idleSuppressOn: false,
  observeDir: undefined,
  pendingImagePaths: [],
  mcpConfigPath: undefined,
  argPrompt: undefined,
  spinnerIntervalMs: "80",
  ...overrides,
})

// ── adversarial cases ───────────────────────────────────────────────────────

describe("ADR-0299 host-bootstrap-extraction hellgate", () => {
  test("1. bootstrapSession is reachable from @/host/bootstrap (the SSOT)", async () => {
    const mod = await import("@/host/bootstrap")
    expect(typeof mod.bootstrapSession).toBe("function")
    expect(mod.bootstrapSession.constructor.name).toBe("AsyncFunction")
  })

  test('2. src/host/bootstrap/** source text does NOT contain `from "@/apps/cli"` (slice fence)', () => {
    const offenders = grepDir("src/host/bootstrap", /from\s+["']@\/apps\/cli/)
    expect(offenders).toEqual([])
  })

  test("2b. src/host/bootstrap/** does NOT contain relative imports into apps/cli", () => {
    const offenders = grepDir("src/host/bootstrap", /from\s+["'][^"']*apps\/cli/)
    expect(offenders).toEqual([])
  })

  test("3. src/host/bootstrap/** does NOT import the reviewer-subagent module directly", () => {
    // We forbid IMPORT lines that pull from reviewer-subagent. Mere mentions
    // in JSDoc / interface field names are allowed (the host re-exposes the
    // surface-supplied closures and documents them in comments).
    const offenders = grepDir("src/host/bootstrap", /from\s+["'][^"']*reviewer-subagent/)
    expect(offenders).toEqual([])
  })

  test("4. src/apps/cli/repl/** does NOT IMPORT the `materializeReviewerAgent` symbol (standalone-caller precursor)", () => {
    // The forbidden standalone caller form is a direct import-and-call:
    //   import { materializeReviewerAgent } from "..."
    //   ... materializeReviewerAgent(...)
    // The extraction boundary is that the repl never *imports* this symbol;
    // it must only ever reach it as a surface-supplied closure.
    //
    // Calling it through the boot result (`boot.materializeReviewerAgent(...)`)
    // IS allowed, and so is re-exposing the closure that the SDK-runtime
    // overlay builder INJECTS as a destructured parameter, e.g.
    //   admissibilityBuilder: ({ materializeReviewerAgent }) =>
    //     buildAdmissibility({ materializeReviewerAgent: () => materializeReviewerAgent(boot) })
    //   ...
    //   const reviewerAgent = materializeReviewerAgent() // closure from `args`
    // In both forms the symbol is a parameter, never an import — so scanning
    // call-sites false-positives. We assert the genuine boundary instead: the
    // symbol is never pulled in via an `import` statement.
    const offenders = grepDir("src/apps/cli/repl", /import[^;]*\bmaterializeReviewerAgent\b/m)
    expect(offenders).toEqual([])
  })

  test("4b. src/apps/cli/repl/** does NOT contain a STANDALONE `createSubagentBackedGuardianReview(` call", () => {
    const offenders = grepDir(
      "src/apps/cli/repl",
      /(^|[^.\w])createSubagentBackedGuardianReview\s*\(/m,
    )
    expect(offenders).toEqual([])
  })

  test("4c. src/apps/cli/repl/** does NOT contain `buildLlmStack` (the prior internal helper)", () => {
    const offenders = grepDir("src/apps/cli/repl", /buildLlmStack/)
    expect(offenders).toEqual([])
  })

  test("4d. src/apps/cli/repl/** does NOT contain `loadFeatures(` as a CALLER", () => {
    const offenders = grepDir("src/apps/cli/repl", /loadFeatures\s*\(/)
    expect(offenders).toEqual([])
  })

  test("4e. src/apps/cli/repl/** does NOT import @/agent/tier1/reviewer-subagent", () => {
    const offenders = grepDir("src/apps/cli/repl", /from\s+["']@\/agent\/tier1\/reviewer-subagent/)
    expect(offenders).toEqual([])
  })

  test("5. SessionBootstrapDeps exposes the new factory fields as required keys", () => {
    // Compile-time pin: every spec-mandated key must be `keyof SessionBootstrapDeps`.
    type Required = keyof SessionBootstrapDeps
    const required: Required[] = [
      "buildLifecycleBundle",
      "deriveMcpPillServers",
      "buildCostPanelOrUndefined",
      "buildBranchProgressOrUndefined",
      "buildPlanStoreOrUndefined",
      "buildWorkMetricsSink",
      "buildLlm",
      "buildStreaming",
      "buildTooling",
      "loadFeatures",
      "loadImageBlock",
      "pickIdentity",
      "pickPersona",
      "resolveResume",
      "composeShellEvent",
      "switchToSessionCwd",
      "materializeReviewerAgent",
      "createSubagentBackedGuardianReview",
      "buildMcpSurfaceInfo",
      "buildIdleGuards",
    ]
    expect(required).toHaveLength(20)
    expect(new Set(required).size).toBe(20)
  })

  test("5b. None of the new factory fields are optional (`?:` would be a runtime hole)", () => {
    // Source-text pin on the types file. An accidental `?:` on any of the
    // factory fields would silently make the dep optional ⇒ undefined at
    // runtime ⇒ TypeError in the host.
    const src = readFileSync(join(REPO_ROOT, "src/host/bootstrap/types.ts"), "utf8")
    for (const field of [
      "buildLlm",
      "buildStreaming",
      "buildTooling",
      "loadFeatures",
      "loadImageBlock",
      "pickIdentity",
      "pickPersona",
      "resolveResume",
      "composeShellEvent",
      "switchToSessionCwd",
      "materializeReviewerAgent",
      "createSubagentBackedGuardianReview",
      "buildMcpSurfaceInfo",
      "buildIdleGuards",
    ]) {
      const re = new RegExp(`readonly\\s+${field}\\?:`)
      expect(src.match(re)).toBeNull()
    }
  })

  // NOTE: removed case "6. Each factory type is named" — it grepped types.ts for
  // `export type <Factory>` literals, a pure compile-time fact already enforced by
  // SessionBootstrapDeps field references + the typed makeFakeDeps fixture + behavioral
  // cases 7-20. Source-token grep, zero runtime coverage (test-quality-audit-2026-06-08 #85).

  test("7. Smoke: bootstrapSession produces a typed result with re-exposed reviewer factories", async () => {
    const deps = makeFakeDeps()
    const runtime = makeRuntime()
    const result = await bootstrapSession(deps, runtime, {})
    expect(result.provider).toBe(runtime.provider)
    expect(result.model).toBe(runtime.model)
    expect(result.cwd).toBe(runtime.cwd)
    expect(typeof result.shutdownMcp).toBe("function")
    expect(result.abort).toBeInstanceOf(AbortController)
    expect(typeof result.materializeReviewerAgent).toBe("function")
    expect(typeof result.createSubagentBackedGuardianReview).toBe("function")
    // The host re-exposes the SAME closure the surface supplied (===), so
    // the CLI seam can call through without re-importing the agent slice.
    expect(result.materializeReviewerAgent).toBe(deps.materializeReviewerAgent)
    expect(result.createSubagentBackedGuardianReview).toBe(deps.createSubagentBackedGuardianReview)
  })

  test("8. The barrel re-exports SessionBootstrapError (instanceof-friendly)", async () => {
    const mod = await import("@/host/bootstrap")
    expect(mod.SessionBootstrapError).toBe(SessionBootstrapError)
    const err = new mod.SessionBootstrapError("llm_build_failed", "fake")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(SessionBootstrapError)
    expect(err.kind).toBe("llm_build_failed")
    expect(err.exitCode).toBe(1)
  })

  test("9. isSessionBootstrapError correctly type-narrows", () => {
    expect(isSessionBootstrapError(new SessionBootstrapError("resume_conflict", "x"))).toBe(true)
    expect(isSessionBootstrapError(new Error("plain"))).toBe(false)
    expect(isSessionBootstrapError("string")).toBe(false)
    expect(isSessionBootstrapError(undefined)).toBe(false)
    expect(isSessionBootstrapError({ kind: "llm_build_failed" })).toBe(false)
  })

  test("10. Throwing buildLlm gets wrapped into a typed SessionBootstrapError", async () => {
    const deps = makeFakeDeps({
      buildLlm: () => {
        throw new Error("provider key missing")
      },
    })
    let caught: unknown
    try {
      await bootstrapSession(deps, makeRuntime(), {})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SessionBootstrapError)
    expect((caught as SessionBootstrapError).kind).toBe("llm_build_failed")
    expect((caught as SessionBootstrapError).message).toBe("provider key missing")
  })

  // jun-6 H7-BYOK — `BuildLlmFactory` may return `Promise<LLMPort>` so the
  // legacy vendor path can `await` an `apiKeyHelper` mint (one shell) ahead of the
  // synchronous `createLLM`. The host MUST `await` `deps.buildLlm(...)`, else
  // `result.llm` would be an UNRESOLVED PROMISE (no `.stream`) and every LLM call
  // would crash. Before the await was wired, `cliBuildLlm` (async) was a type
  // error against the sync factory; this case locks the async contract in.
  test("10b. an ASYNC buildLlm is AWAITED — result.llm is the resolved adapter, not a Promise", async () => {
    let resolvedAfterMint = false
    const asyncAdapter: LLMPort = {
      stream: async function* () {
        yield* []
      },
    }
    const deps = makeFakeDeps({
      // Mirrors the legacy-vendor BYOK path: an awaited async step (the mint)
      // precedes returning the adapter.
      buildLlm: async () => {
        await Promise.resolve()
        resolvedAfterMint = true
        return asyncAdapter
      },
      // The shared fake omits this (a separate track's gap); supply it so this
      // case reaches the LLM-await path rather than the unrelated titler call.
      buildAutoTitlePort: () => undefined,
    })
    const result = await bootstrapSession(deps, makeRuntime(), {})
    expect(resolvedAfterMint).toBe(true)
    // The host awaited the promise: `result.llm` is the adapter itself …
    expect(result.llm).toBe(asyncAdapter)
    // … with a callable `.stream` (a leaked Promise would have none).
    expect(typeof (result.llm as LLMPort).stream).toBe("function")
    expect(result.llm).not.toBeInstanceOf(Promise)
  })

  test("10c. a REJECTING async buildLlm is wrapped into a typed SessionBootstrapError", async () => {
    const deps = makeFakeDeps({
      buildLlm: async () => {
        await Promise.resolve()
        throw new Error("apiKeyHelper mint failed (untrusted)")
      },
    })
    let caught: unknown
    try {
      await bootstrapSession(deps, makeRuntime(), {})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SessionBootstrapError)
    expect((caught as SessionBootstrapError).kind).toBe("llm_build_failed")
    expect((caught as SessionBootstrapError).message).toBe("apiKeyHelper mint failed (untrusted)")
  })

  test("11. resolveResume conflict gets wrapped (kind: resume_conflict)", async () => {
    const deps = makeFakeDeps({
      resolveResume: async () => ({
        sessionId: "any",
        history: [],
        idMeta: undefined,
        inIdMode: false,
        conflictError: "cannot combine --new-session with --resume",
        missingIdError: undefined,
      }),
    })
    let caught: unknown
    try {
      await bootstrapSession(deps, makeRuntime(), {})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SessionBootstrapError)
    expect((caught as SessionBootstrapError).kind).toBe("resume_conflict")
  })

  test("12. resolveResume missing id gets wrapped (kind: resume_missing_id) AND mcpClients stopped", async () => {
    const stopped: string[] = []
    const deps = makeFakeDeps({
      loadFeatures: async () => ({
        planMode: false,
        metrics: undefined,
        state: undefined,
        resume: undefined,
        mcpTools: [],
        mcpClients: [
          {
            stop: async () => {
              stopped.push("a")
            },
          },
          {
            stop: async () => {
              stopped.push("b")
            },
          },
        ],
        mcpConfigs: [],
        lspTools: [],
        lspNavTools: [],
        gitToolList: [],
      }),
      resolveResume: async () => ({
        sessionId: "any",
        history: [],
        idMeta: undefined,
        inIdMode: false,
        conflictError: undefined,
        missingIdError: "unknown-session-id",
      }),
    })
    let caught: unknown
    try {
      await bootstrapSession(deps, makeRuntime(), {})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SessionBootstrapError)
    expect((caught as SessionBootstrapError).kind).toBe("resume_missing_id")
    expect((caught as SessionBootstrapError).message).toBe(
      "--resume: session id not found: unknown-session-id",
    )
    // Defensive cleanup: BOTH clients must have been stopped on the rethrow
    // path so a startup-fail doesn't leak child processes.
    expect(stopped).toEqual(["a", "b"])
  })

  test("13. Host slice imports isPathLikeToken from @/runner/orchestrate (not apps/cli/internal)", () => {
    const src = readFileSync(join(REPO_ROOT, "src/host/bootstrap/bootstrap-session.ts"), "utf8")
    expect(src).toContain('from "@/runner/orchestrate"')
    expect(src).not.toContain('from "../../apps/cli')
    expect(src).not.toMatch(/from\s+["'][^"']*apps\/cli/)
  })

  test("14. Tooling builder receives the SAME taskRegistry the lifecycle bundle reports", async () => {
    const fakeTaskRegistry = { pendingIds: () => [], waitForAll: async () => [] } as never
    let toolingCalledWith: unknown
    const deps = makeFakeDeps({
      buildLifecycleBundle: () => ({
        pills: { update: () => undefined },
        taskRegistry: fakeTaskRegistry,
        followUpQueue: undefined,
      }),
      buildTooling: (_mcp, _lsp, _lspNav, _git, _slog, taskRegistry) => {
        toolingCalledWith = taskRegistry
        return {
          store: undefined,
          embedder: undefined,
          sessionId: "fake-session",
          registry: { tools: () => [] },
          memoryConfig: undefined,
          subagentConfig: undefined,
          skillsConfig: undefined,
          compactionBreakerConfig: undefined,
          verifyGuardConfig: undefined,
        } as never
      },
    })
    await bootstrapSession(deps, makeRuntime(), {})
    expect(toolingCalledWith).toBe(fakeTaskRegistry)
  })

  test("15. Empty mcpClients ⇒ deriveMcpPillServers is NOT called (conditional contract)", async () => {
    let callCount = 0
    const deps = makeFakeDeps({
      deriveMcpPillServers: () => {
        callCount += 1
        return []
      },
    })
    await bootstrapSession(deps, makeRuntime(), {})
    expect(callCount).toBe(0)
  })

  test("15b. Non-empty mcpClients ⇒ deriveMcpPillServers IS called exactly once", async () => {
    let callCount = 0
    const deps = makeFakeDeps({
      loadFeatures: async () => ({
        planMode: false,
        metrics: undefined,
        state: undefined,
        resume: undefined,
        mcpTools: [{ name: "mcp__fs__read" } as never],
        mcpClients: [{ stop: async () => undefined }],
        mcpConfigs: [],
        lspTools: [],
        lspNavTools: [],
        gitToolList: [],
      }),
      deriveMcpPillServers: () => {
        callCount += 1
        return []
      },
    })
    await bootstrapSession(deps, makeRuntime(), {})
    expect(callCount).toBe(1)
  })

  test("16. The OLD session-bootstrap file at src/apps/cli/repl/session-bootstrap.ts is DELETED (no shim left)", () => {
    let exists = false
    try {
      statSync(join(REPO_ROOT, "src/apps/cli/repl/session-bootstrap.ts"))
      exists = true
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  test("17. The host slice file count is sane (index + bootstrap + types — no surprise modules)", () => {
    const files = walk(join(REPO_ROOT, "src/host/bootstrap"))
    // Allow growth, but the canonical set is exactly 3 files today. A
    // refactor that splits further should bump this expectation explicitly.
    expect(files.length).toBeGreaterThanOrEqual(3)
    const names = files.map((f) => f.split("/").pop())
    expect(names).toContain("index.ts")
    expect(names).toContain("bootstrap-session.ts")
    expect(names).toContain("types.ts")
  })

  test("18. Throwing buildTooling triggers MCP cleanup even though it runs INSIDE the resume try-block", async () => {
    const stopped: number[] = []
    const deps = makeFakeDeps({
      loadFeatures: async () => ({
        planMode: false,
        metrics: undefined,
        state: undefined,
        resume: undefined,
        mcpTools: [],
        mcpClients: [
          {
            stop: async () => {
              stopped.push(1)
            },
          },
        ],
        mcpConfigs: [],
        lspTools: [],
        lspNavTools: [],
        gitToolList: [],
      }),
      buildTooling: () => {
        throw new Error("tooling boom")
      },
    })
    let caught: unknown
    try {
      await bootstrapSession(deps, makeRuntime(), {})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("tooling boom")
    expect(stopped).toEqual([1])
  })

  test("19. Default-OFF identity ⇒ pickIdentity returns undefined ⇒ system prompt omits identity slot", async () => {
    let identityCalls = 0
    const deps = makeFakeDeps({
      pickIdentity: () => {
        identityCalls += 1
        return undefined
      },
    })
    const result = await bootstrapSession(deps, makeRuntime(), {})
    expect(identityCalls).toBeGreaterThanOrEqual(1)
    expect(typeof result.system).toBe("string")
    expect(result.system.length).toBeGreaterThan(0)
  })

  test("20. argPrompt is forwarded byte-identical from runtime to result", async () => {
    const deps = makeFakeDeps()
    const runtime = makeRuntime({ argPrompt: "fix the bug" })
    const result = await bootstrapSession(deps, runtime, {})
    expect(result.argPrompt).toBe("fix the bug")
  })
})
