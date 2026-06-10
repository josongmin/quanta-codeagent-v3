import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildToolingCore } from "@/runner/assemble/tooling"

/**
 * Assemble-time gate-config logs are DEBUG, not INFO (jun-10 banner cleanup).
 *
 * WHY: at default log level every interactive launch opened with a wall of
 * JSONL config dumps (`subagent.on` with the full task-registry shape,
 * `skills.on`, `llm.live_usage.on`, …) before the prompt — machine-only
 * diagnostics painted at operator level. The welcome banner now owns the
 * human-facing first paint; the gate dumps stay available via
 * `QUANTA_LOG_LEVEL=debug` (events + fields unchanged — only the level moved).
 */

const REPO_ROOT = join(import.meta.dir, "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

const captureSlog = () => {
  const calls: Array<{ level: string; event: string }> = []
  const mk =
    (level: string) =>
    (event: string, _fields?: Record<string, unknown>): void => {
      calls.push({ level, event })
    }
  return {
    calls,
    slog: {
      debug: mk("debug"),
      info: mk("info"),
      warn: mk("warn"),
      error: mk("error"),
      child: () => undefined,
    } as never,
  }
}

describe("buildToolingCore gate logs — behavior", () => {
  test("subagent/skills/verify-guard/compaction config dumps emit at DEBUG, never INFO", () => {
    const { calls, slog } = captureSlog()
    buildToolingCore({
      store: undefined,
      embedder: undefined,
      sessionId: "s-log-level",
      memoryConfig: undefined,
      subagentConfig: {} as never,
      skillsConfig: { dirs: [] } as never,
      compactionBreakerConfig: { maxAttempts: 1 } as never,
      verifyGuardConfig: {} as never,
      mcpTools: [],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
      slog,
    } as never)

    const gateEvents = ["subagent.on", "skills.on", "compaction.breaker.config", "verify.guard.on"]
    for (const event of gateEvents) {
      const hit = calls.filter((c) => c.event === event)
      expect(hit.length).toBeGreaterThan(0) // still emitted (observability kept)
      expect(hit.every((c) => c.level === "debug")).toBe(true)
    }
    expect(calls.filter((c) => c.level === "info")).toHaveLength(0)
  })
})

describe("assemble gate logs — source pins for the sibling assemble modules", () => {
  test("llm.ts gate dumps (fallback/auto-permission/live-usage) are slog.debug", () => {
    const src = read("src/runner/assemble/llm.ts")
    expect(src).toContain('slog.debug("llm.fallback.on"')
    expect(src).toContain('slog.debug("permission.auto.on"')
    expect(src).toContain('slog.debug("llm.live_usage.on"')
    expect(src).not.toContain('slog.info("llm.fallback.on"')
    expect(src).not.toContain('slog.info("permission.auto.on"')
    expect(src).not.toContain('slog.info("llm.live_usage.on"')
  })

  test("streaming.ts observe.on dump is slog.debug", () => {
    const src = read("src/runner/assemble/streaming.ts")
    expect(src).toContain('slog.debug("observe.on"')
    expect(src).not.toContain('slog.info("observe.on"')
  })
})
