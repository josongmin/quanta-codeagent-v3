/**
 * ADR-0308 — headless second-consumer hellgate (ARCH-07).
 *
 * After Waves 1-3 thinned the CLI surface and CLI-01 (ADR-0299) extracted
 * `bootstrapSession` into the surface-agnostic `@/host/bootstrap` slice, this
 * hellgate PROVES the host layer is reusable by standing up a SECOND
 * surface (`src/apps/headless/`) and driving the SAME `bootstrapSession` +
 * `@/runner` / `@/host/runtime` / `@/sdk/runtime` cores end-to-end without
 * touching the CLI slice.
 *
 * Cases (12 mandated by the ticket, +adversarial extras):
 *
 *  1. Source fence — `src/apps/headless/**` text never contains a CLI import.
 *  2. Slice fence — every import in headless source matches a whitelist of
 *     allowed `@/` prefixes (`@/host/bootstrap`, `@/host/runtime`,
 *     selected internal `@/runner/*` paths, `@/sdk/runtime`, `@/llm` (type), `@/stream`,
 *     `@/permission` (type), `@/tool` (registry+type), `@/agent` (type),
 *     `@/observability` (logger), `@/shared`, `node:*`).
 *  3. Smoke — `runHeadlessOnce({prompt:"ping",fakeCompletion:{text:"pong"}})`
 *     returns `outcome.reason === "completed"` and the final assistant
 *     message contains "pong".
 *  4. No CLI-surface state — `runHeadlessOnce` does not call `process.exit`,
 *     does not read `process.argv` directly, does not read `process.env`
 *     directly.
 *  5. Lean SDK result — the public surface exposes session metadata +
 *     outcome/messages/events/snapshot/wires, NOT the bootstrap bag.
 *  6. Multiple turns — a tool-call script followed by a completion script
 *     ticks the orchestration loop twice.
 *  7. Abort signal — passing an already-aborted signal returns immediately
 *     with `outcome.reason === "aborted"`.
 *  8. No MCP leak — the public result does not expose mcp client/config
 *     bags or shutdown hooks.
 *  9. No surface chrome / bootstrap bag — the result does NOT contain
 *     CLI TTY/UI keys or host bootstrap-only internals.
 * 10. Determinism — two calls with identical fake completion produce
 *     identical assistant text + outcome reason.
 * 11. Forbidden import counter — zero headless source files match the
 *     three forbidden-prefix patterns (cli/bench/agent surface).
 * 12. Adversarial: `runHeadlessOnce` honors a default cwd (`/tmp/headless`)
 *     instead of `process.cwd()` — proving env isolation.
 * 13. Adversarial: an empty `fakeCompletions` list throws at FakeLlm
 *     construction (no silent hang).
 * 14. Adversarial: the recording stream captures at least one
 *     `llm_request` event during the smoke, confirming the runner actually
 *     drove the LLM via the bootstrap.
 * 15. No public `SessionDeps` leak: the headless public result exposes only
 *     a lean `wires` proof, not the internal `SessionDeps` bag.
 * 16. Execution-plane parity: subagent-enabled headless runs expose the
 *     same fork / delegation / background slots as the shared host helper.
 * 17. Memory-auto parity: `QUANTA_MEMORY_AUTO=on` wires stage1 outputs and
 *     the session-end consolidator without importing CLI-only helpers.
 *
 * Tests run HEADLESS-LEVEL: no `process.env` mocking, no `mock.module`.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import {
  FakeLlm,
  type HeadlessRunInput,
  type HeadlessRunResult,
  runHeadlessOnce,
} from "@/apps/headless"
import type { StreamEvent } from "@/llm"

// ── helpers ──────────────────────────────────────────────────────────────────

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname
const HEADLESS_DIR = join(REPO_ROOT, "src/apps/headless")

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

const readHeadless = (): ReadonlyArray<{ readonly path: string; readonly body: string }> =>
  walk(HEADLESS_DIR).map((p) => ({ path: p, body: readFileSync(p, "utf8") }))

// Allowed import prefixes for `src/apps/headless/**`. Anything else fails the
// slice fence. NOTE: the headless slice may use selected INTERNAL runner
// modules, but must not depend on the public `@/runner` / `@/runner/assemble`
// / `@/runner/orchestrate` barrels.
const ALLOWED_PREFIXES: readonly string[] = [
  "@/host/bootstrap",
  "@/host/runtime",
  "@/runner/assemble/config",
  "@/runner/assemble/tooling",
  "@/runner/orchestrate/resume-fsm",
  // ADR-0303 — the shared turn-completion driver: headless funnels through the
  // same `@/runner` primitive as the CLI so the approval-resolution loop is
  // defined once (this is the ADR-0308 "second consumer drives runner cores"
  // intent). Concrete module path, NOT the public `@/runner/orchestrate` barrel.
  "@/runner/orchestrate/session-turn-driver",
  "@/ipc/session",
  "@/sdk/runtime",
  "@/agent",
  "@/llm",
  "@/stream",
  "@/permission",
  "@/tool",
  "@/observability",
  "@/shared",
  // jun-15 — lifecycle bundle now creates an activity store (pure leaf module).
  "@/activity",
  // Internal sibling files within the slice.
  "./",
  "../",
]

const isAllowedSpecifier = (spec: string): boolean => {
  if (spec.startsWith("node:")) return true
  for (const p of ALLOWED_PREFIXES)
    if (spec === p || spec.startsWith(`${p}/`) || spec === p.replace(/\/$/, "")) return true
  // Relative imports inside the slice are fine.
  if (spec.startsWith("./") || spec.startsWith("../")) return true
  return false
}

const collectImports = (body: string): readonly string[] => {
  // Matches `from "..."` and `from '...'` — the only import forms in the
  // headless slice. Re-exports (`export ... from "..."`) match the same shape.
  const out: string[] = []
  const re = /from\s+["']([^"']+)["']/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: textbook regex loop
  while ((m = re.exec(body)) !== null) {
    const s = m[1]
    if (s) out.push(s)
  }
  return out
}

// ── ticket-mandated cases (CASE 1 — CASE 9 + extras) ────────────────────────

describe("ADR-0308 headless second-consumer hellgate", () => {
  test('CASE 1 (source fence): src/apps/headless/** does NOT contain `from "@/apps/cli`', () => {
    const offenders = readHeadless().filter((f) => /from\s+["']@\/apps\/cli/.test(f.body))
    expect(offenders.map((o) => o.path)).toEqual([])
  })

  test("CASE 1b: src/apps/headless/** does NOT contain relative ../cli imports", () => {
    const offenders = readHeadless().filter((f) => /from\s+["'][^"']*\.\.\/cli/.test(f.body))
    expect(offenders.map((o) => o.path)).toEqual([])
  })

  test("CASE 1c: no path starting with `src/apps/cli` appears anywhere in headless source", () => {
    const offenders = readHeadless().filter((f) => /from\s+["'][^"']*src\/apps\/cli/.test(f.body))
    expect(offenders.map((o) => o.path)).toEqual([])
  })

  test("CASE 2 (slice fence): every headless import matches a whitelisted prefix", () => {
    const violations: Array<{ path: string; spec: string }> = []
    for (const f of readHeadless()) {
      for (const spec of collectImports(f.body)) {
        if (!isAllowedSpecifier(spec)) violations.push({ path: f.path, spec })
      }
    }
    expect(violations).toEqual([])
  })

  test("CASE 2b: public headless entry keeps bootstrap/runtime compat behind a local adapter", () => {
    const source = readFileSync(join(HEADLESS_DIR, "index.ts"), "utf8")
    expect(source).toContain('from "./session-bridge"')
    // CASE 2b: src/apps/headless/index.ts `from "@/host/bootstrap"` import-fence
    // migrated to biome noRestrictedImports (see biome.json).
    expect(source).not.toContain("createRuntimeFromBootstrap(")
    expect(source).not.toContain("bootstrapSession(")
  })

  test("CASE 2d: headless never imports runner public barrels", () => {
    const offenders: Array<{ path: string; spec: string }> = []
    for (const f of readHeadless()) {
      for (const spec of collectImports(f.body)) {
        if (
          spec === "@/runner" ||
          spec === "@/runner/assemble" ||
          spec === "@/runner/orchestrate"
        ) {
          offenders.push({ path: f.path, spec })
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("CASE 2e: the private session bridge is the only runtime compat owner", () => {
    const owners = readHeadless()
      .filter((f) => f.path.endsWith(".ts"))
      .filter((f) => /bootstrapSession\(|createRuntimeFromBootstrap\(/.test(f.body))
      .map((f) => f.path.replace(`${HEADLESS_DIR}/`, ""))
      .sort()
    expect(owners).toEqual(["session-bridge.ts"])
  })

  test("CASE 2b: `@/agent` imports in headless are TYPE-ONLY (no runtime reach into agent slice)", () => {
    const offenders: Array<{ path: string; line: string }> = []
    for (const f of readHeadless()) {
      // Match imports of `@/agent` (NOT `@/agent/<anything>` — sub-paths are
      // intentionally inspected separately). The headless slice only needs
      // the `AgentConfig` / `AgentOutcome` types from the barrel.
      const lines = f.body.split("\n")
      for (const line of lines) {
        const m = line.match(/^\s*import\s+([^"';]+?)\s+from\s+["']@\/agent["']\s*$/)
        if (!m) continue
        const head = m[1] ?? ""
        // Anything NOT prefixed with `type ` (and not a side-effect-only
        // import) is a runtime reach. `import type { ... }` is OK.
        if (!head.startsWith("type ")) offenders.push({ path: f.path, line })
      }
    }
    expect(offenders).toEqual([])
  })

  test("CASE 2c: `@/llm` imports are TYPE-ONLY", () => {
    const offenders: Array<{ path: string; line: string }> = []
    for (const f of readHeadless()) {
      const lines = f.body.split("\n")
      for (const line of lines) {
        const m = line.match(/^\s*import\s+([^"';]+?)\s+from\s+["']@\/llm["']\s*$/)
        if (!m) continue
        const head = m[1] ?? ""
        if (!head.startsWith("type ")) offenders.push({ path: f.path, line })
      }
    }
    expect(offenders).toEqual([])
  })

  test("CASE 3 (smoke): runHeadlessOnce returns completed + 'pong' in the final message", async () => {
    const result = await runHeadlessOnce({
      prompt: "ping",
      fakeCompletion: { text: "pong" },
    })
    expect(result.outcome.reason).toBe("completed")
    // Final assistant message contains "pong".
    const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant")
    expect(lastAssistant).toBeDefined()
    const lastText = lastAssistant?.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(lastText).toContain("pong")
  })

  test("CASE 4: runHeadlessOnce source (executable code only) does NOT call process.exit / read process.argv / read process.env directly", () => {
    const { body } = readHeadless().find((f) => f.path.endsWith("/index.ts")) ?? {
      body: "",
    }
    // Strip JSDoc + `//` line comments — same rationale as CASE 4b.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
    expect(code).not.toMatch(/process\.exit\s*\(/)
    expect(code).not.toMatch(/process\.argv\b/)
    expect(code).not.toMatch(/process\.env\b/)
  })

  test("CASE 4b: NO headless source file reads process.argv / process.env / calls process.exit (executable code only)", () => {
    // Strip block JSDoc + `//` line comments before grepping so a doc
    // comment that MENTIONS `process.env` (as ours legitimately does to
    // explain the slice's env-isolation invariant) does not trip the gate.
    const stripComments = (body: string): string => {
      const noBlock = body.replace(/\/\*[\s\S]*?\*\//g, "")
      const noLine = noBlock
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n")
      return noLine
    }
    const offenders: Array<{ path: string; needle: string }> = []
    for (const f of readHeadless()) {
      const code = stripComments(f.body)
      if (/process\.exit\s*\(/.test(code)) offenders.push({ path: f.path, needle: "process.exit(" })
      if (/process\.argv\b/.test(code)) offenders.push({ path: f.path, needle: "process.argv" })
      if (/process\.env\b/.test(code)) offenders.push({ path: f.path, needle: "process.env" })
    }
    expect(offenders).toEqual([])
  })

  test("CASE 5 (public result shape): result is lean SDK metadata plus snapshot, not the bootstrap bag", async () => {
    const result = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
    })

    const expectedFields = [
      "provider",
      "model",
      "mode",
      "maxTurns",
      "cwd",
      "sessionId",
      "outcome",
      "messages",
      "events",
      "snapshot",
      "wires",
    ]

    expect(Object.keys(result).sort()).toEqual([...expectedFields].sort())
    expect(result.snapshot).toBeDefined()
    expect(result.snapshot?.sessionId).toBe(result.sessionId)

    const omittedInternalKeys = [
      "runtime",
      "slog",
      "permission",
      "features",
      "tooling",
      "mcpSurface",
      "lifecyclePills",
      "lifecycleTaskRegistry",
      "lifecycleFollowUpQueue",
      "history",
      "abort",
      "shutdownMcp",
      "materializeReviewerAgent",
      "createSubagentBackedGuardianReview",
    ]
    for (const key of omittedInternalKeys) {
      expect(result).not.toHaveProperty(key)
    }
  })

  test("CASE 6 (multiple turns): a tool-call script followed by a completion ticks the loop twice", async () => {
    // Turn 1 — model emits a tool_use for `bash` (registered by default-tools
    // bridge? In our headless slice we use an EMPTY registry, so a tool_use
    // for an unknown name yields a structured tool error from the loop. The
    // important invariant is that the orchestration TICKS a second time
    // (the loop emits the tool_use, dispatches it, observes the error, and
    // proceeds to the next turn where the model responds with text).
    const toolScript: StreamEvent[] = [
      { type: "tool_use_start", id: "t1", name: "noop_tool" },
      { type: "tool_use_delta", id: "t1", delta: "{}" },
      { type: "tool_use_end", id: "t1", input: {} },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const result = await runHeadlessOnce({
      prompt: "do work",
      fakeCompletions: [{ events: toolScript }, { text: "done" }],
      maxTurns: 3,
    })
    // The loop should have invoked the LLM twice (turn 1 = tool round,
    // turn 2 = completion). We assert via the recording stream's `llm_request`
    // count — runner emits one per provider call.
    const llmRequests = result.events.filter((e) => e.type === "llm_request")
    expect(llmRequests.length).toBeGreaterThanOrEqual(2)
    // Final outcome should be `completed` — the second turn ended in
    // `end_turn`.
    expect(result.outcome.reason).toBe("completed")
  })

  test("CASE 7 (abort signal): an already-aborted signal returns reason=aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await runHeadlessOnce({
      prompt: "irrelevant",
      fakeCompletion: { text: "irrelevant" },
      signal: ac.signal,
    })
    expect(result.outcome.reason).toBe("aborted")
    expect(result.snapshot).toBeUndefined()
    expect(result.events).toEqual([])
  })

  test("CASE 8 (no MCP): the headless path completes without exposing MCP handles on the public result", async () => {
    const result = await runHeadlessOnce({
      prompt: "ping",
      fakeCompletion: { text: "pong" },
    })
    expect(result.outcome.reason).toBe("completed")
    expect(result).not.toHaveProperty("features")
    expect(result).not.toHaveProperty("mcpSurface")
    expect(result).not.toHaveProperty("shutdownMcp")
  })

  test("CASE 9 (no surface chrome): result does NOT carry CLI chrome or bootstrap-only internals", async () => {
    const result: HeadlessRunResult = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
    })

    const omittedKeys = [
      "statusBar",
      "turnIndicator",
      "turnSummary",
      "costPanel",
      "debugHandle",
      "timelinePanel",
      "pills",
      "runtime",
      "lifecyclePills",
      "branchProgress",
      "planStore",
    ] as const

    for (const key of omittedKeys) {
      expect(result).not.toHaveProperty(key)
    }
  })

  test("CASE 10 (determinism): two calls with identical fakes produce identical assistant text + reason", async () => {
    const input: HeadlessRunInput = {
      prompt: "ping",
      fakeCompletion: { text: "pong" },
    }
    const a = await runHeadlessOnce(input)
    const b = await runHeadlessOnce(input)
    expect(a.outcome.reason).toBe(b.outcome.reason)
    const textOf = (r: HeadlessRunResult): string => {
      const last = [...r.messages].reverse().find((m) => m.role === "assistant")
      return (
        last?.content
          .filter((c) => c.type === "text")
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("") ?? ""
      )
    }
    expect(textOf(a)).toBe(textOf(b))
  })

  test("CASE 11 (forbidden-import counter): zero headless source files match cli/bench/agent surface patterns", () => {
    let count = 0
    const forbiddenPatterns = [
      /from\s+["']@\/apps\/cli/,
      /from\s+["']@\/apps\/bench/,
      /from\s+["']@\/apps\/agent/,
      /from\s+["'][^"']*src\/apps\/cli/,
      /from\s+["'][^"']*src\/apps\/bench/,
      /from\s+["'][^"']*src\/apps\/agent/,
    ]
    for (const f of readHeadless()) {
      for (const re of forbiddenPatterns) if (re.test(f.body)) count += 1
    }
    expect(count).toBe(0)
  })

  test("CASE 12: runHeadlessOnce honors a caller-supplied cwd (not process.cwd())", async () => {
    const result = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
      cwd: "/tmp/headless-custom-cwd",
    })
    expect(result.cwd).toBe("/tmp/headless-custom-cwd")
  })

  test("CASE 13 (adversarial): empty fakeCompletions trips a thrown error at FakeLlm construction", () => {
    expect(() => new FakeLlm([])).toThrow(/at least one fake completion/)
  })

  test("CASE 14: the recording stream captures at least one `llm_request` event during the smoke", async () => {
    const result = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
    })
    const llmReqs = result.events.filter((e) => e.type === "llm_request")
    expect(llmReqs.length).toBeGreaterThanOrEqual(1)
    // Confirm the runner saw the FAKE provider id (not a real one).
    expect((llmReqs[0] as { provider?: string }).provider).toBe("headless")
  })

  test("CASE 15: headless public result does not leak SessionDeps", async () => {
    const result = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
    })

    expect(result).not.toHaveProperty("sessionDeps")
    expect(result.wires.executionPlane.conversationCheckpoint).toBe(true)
    expect(result.wires.executionPlane.responsesContinuation).toBe(true)
  })

  test("CASE 16: subagent-enabled headless runs gain live execution-plane slots", async () => {
    const result = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
      subagentConfig: {},
    })

    expect(result.wires.executionPlane.conversationCheckpoint).toBe(true)
    expect(result.wires.executionPlane.responsesContinuation).toBe(true)
    expect(result.wires.executionPlane.fork).toBe(true)
    expect(result.wires.executionPlane.forkSession).toBe(true)
    expect(result.wires.executionPlane.delegation).toBe(true)
    expect(result.wires.executionPlane.subagentBackground).toBe(true)
    expect(result.wires.executionPlane.autoBackground).toBe(true)
  })

  test("CASE 17: QUANTA_MEMORY_AUTO=on wires second-consumer memory auto ports", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "q-headless-memory-auto-"))
    try {
      const result = await runHeadlessOnce({
        prompt: "x",
        fakeCompletion: { text: "y" },
        env: {
          QUANTA_MEMORY_AUTO: "on",
          QUANTA_MEMORY_PHASE2: "on",
        },
        homeDir,
      })

      expect(result.wires.memoryAuto.sessionCtx).toBe(false)
      // ADR-0556: the sibling JSONL stage1 store was deleted (System B was dead
      // in effect). The key stays in the contract for shape stability; its
      // value is now constant `false`.
      expect(result.wires.memoryAuto.stage1OutputsStore).toBe(false)
      expect(result.wires.memoryAuto.memoryConsolidator).toBe(true)
      expect(result.wires.memoryAuto.memoryConsolidatorEnabled).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
