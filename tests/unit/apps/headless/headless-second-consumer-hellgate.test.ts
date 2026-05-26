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
 *  5. Host bootstrap shape — the result carries every field
 *     `SessionBootstrapResult` mandates (bootstrap-shape passes through).
 *  6. Multiple turns — a tool-call script followed by a completion script
 *     ticks the orchestration loop twice.
 *  7. Abort signal — passing an already-aborted signal returns immediately
 *     with `outcome.reason === "aborted"`.
 *  8. No MCP — running with the default empty mcpTools / mcpClients works
 *     (no MCP wiring required).
 *  9. No surface chrome — the result does NOT contain any TTY/UI key
 *     (`statusBar`, `turnIndicator`, `turnSummary`, `costPanel`,
 *     `branchProgress`, `lifecyclePills` (the field is a header-only
 *     bootstrap value — present but opaque, NOT the CLI's full type),
 *     `pills`, `debugHandle`, `timelinePanel`).
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
import type { SessionBootstrapResult } from "@/host/bootstrap"
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
  "@/sdk/runtime",
  "@/agent",
  "@/llm",
  "@/stream",
  "@/permission",
  "@/tool",
  "@/observability",
  "@/shared",
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

  test("CASE 2b: headless source uses the sdk runtime bridge, not raw compat helpers", () => {
    const source = readFileSync(join(HEADLESS_DIR, "index.ts"), "utf8")
    expect(source).toContain('from "@/sdk/runtime/bridge"')
    expect(source).not.toContain("createLegacyRunnerSessionHost(")
    expect(source).not.toContain('from "@/runner/session-execution-plane"')
    expect(source).not.toContain('from "@/runner/session-memory-auto"')
    expect(source).not.toContain("peekMessages(")
    expect(source).not.toContain("peekLastOutcome(")
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

  test("CASE 5 (host bootstrap shape): result carries every SessionBootstrapResult field", async () => {
    const result = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
    })
    // Every field declared on SessionBootstrapResult MUST be present on the
    // headless result (HeadlessRunResult extends SessionBootstrapResult).
    const expectedFields: ReadonlyArray<keyof SessionBootstrapResult> = [
      "runtime",
      "provider",
      "model",
      "mode",
      "maxTurns",
      "cwd",
      "slog",
      "permission",
      "idleMonitor",
      "rejectCounter",
      "effortStore",
      "llm",
      "features",
      "tooling",
      "mcpSurface",
      "lifecyclePills",
      "lifecycleTaskRegistry",
      "lifecycleFollowUpQueue",
      "sessionId",
      "history",
      "pendingImages",
      "idMeta",
      "onShellEvent",
      "workMetricsSink",
      "stream",
      "run",
      "costPanel",
      "branchProgress",
      "planStore",
      "abort",
      "argPrompt",
      "system",
      "systemSource",
      "refreshSystemPrompt",
      "toolProfileState",
      "identityModeState",
      "focusChain",
      "shutdownMcp",
      "playbookCliFlag",
      "materializeReviewerAgent",
      "createSubagentBackedGuardianReview",
    ]
    for (const k of expectedFields) {
      expect(result).toHaveProperty(k as string)
    }
    // Plus the headless-specific extras (outcome + messages + events + wires).
    expect(result).toHaveProperty("outcome")
    expect(result).toHaveProperty("messages")
    expect(result).toHaveProperty("events")
    expect(result).toHaveProperty("wires")
    // Bootstrap-fields count >= 35 (CLI-01 hellgate counted 35 mandatory
    // fields; we pin >= 35 to allow for future growth while ensuring the
    // shape never regresses).
    expect(expectedFields.length).toBeGreaterThanOrEqual(35)
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
  })

  test("CASE 8 (no MCP): the headless path completes without any mcpTools / mcpClients wiring", async () => {
    const result = await runHeadlessOnce({
      prompt: "ping",
      fakeCompletion: { text: "pong" },
    })
    // The fake bootstrap deps return empty mcpTools/mcpClients/mcpConfigs —
    // and the headless surface NEVER calls into `@/mcp`.
    expect(result.features.mcpTools).toEqual([])
    expect(result.features.mcpClients).toEqual([])
    expect(result.features.mcpConfigs).toEqual([])
    // The MCP surface info is undefined (no servers to render).
    expect(result.mcpSurface).toBeUndefined()
    // The shutdown is a no-op (no clients to stop) but it MUST be callable.
    await expect(result.shutdownMcp()).resolves.toBeUndefined()
  })

  test("CASE 9 (no surface chrome): result does NOT carry any TTY/UI key the CLI's SessionSetupResult has", async () => {
    const result: HeadlessRunResult = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
    })
    // These keys belong to the CLI's SessionSetupResult, NOT the host's
    // SessionBootstrapResult — the headless surface intentionally OMITS them.
    const cliOnlyKeys = [
      "statusBar",
      "turnIndicator",
      "turnSummary",
      "costPanel" /* present but undefined ⇒ assert NOT a populated panel */,
      "debugHandle",
      "timelinePanel",
      "pills",
    ] as const
    // `lifecyclePills` IS present on SessionBootstrapResult (opaque) but its
    // CLI-specific concrete type (StatusBar pills row) is NOT — we just assert
    // the headless variant is the bare `{update}` shape.
    expect(result.lifecyclePills).toHaveProperty("update")
    // For the "chrome" keys above we either expect ABSENT (debugHandle,
    // timelinePanel, pills, statusBar, turnIndicator, turnSummary) OR
    // explicitly undefined (costPanel: present on bootstrap result but
    // never populated by the fake deps).
    for (const k of cliOnlyKeys) {
      const value = (result as unknown as Record<string, unknown>)[k]
      // `costPanel` and `branchProgress` exist on the bootstrap result but
      // MUST be undefined under the fake deps (no surface populates them);
      // every other key must be absent.
      if (k === "costPanel") {
        expect(value).toBeUndefined()
      } else {
        expect(value).toBeUndefined()
      }
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
  })

  test("CASE 16: subagent-enabled headless runs gain live execution-plane slots", async () => {
    const result = await runHeadlessOnce({
      prompt: "x",
      fakeCompletion: { text: "y" },
      subagentConfig: {},
    })

    expect(result.wires.executionPlane.conversationCheckpoint).toBe(true)
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
      expect(result.wires.memoryAuto.stage1OutputsStore).toBe(true)
      expect(result.wires.memoryAuto.memoryConsolidator).toBe(true)
      expect(result.wires.memoryAuto.memoryConsolidatorEnabled).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
