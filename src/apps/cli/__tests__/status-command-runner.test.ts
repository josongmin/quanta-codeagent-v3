/**
 * ticket-15 §11.7(A) — scriptable statusLine runner hellgate.
 *
 * runStatusCommand:
 *   §R-1  the CC `Status` JSON is injected on the child's STDIN and round-trips
 *         (real subprocess: `cat` echoes stdin → we recover the payload)
 *   §R-2  stdout FIRST LINE only (later lines dropped)
 *   §R-3  ANSI color is passed through untouched when it fits
 *   §R-4  truncate to terminal width (visible cols), ANSI reset appended on cut
 *   §R-5  timeout ⇒ "" + degraded (child killed)
 *   §R-6  non-zero exit ⇒ degraded but stdout still surfaced
 *   §R-7  spawn error ⇒ "" + degraded (never throws)
 *   §R-8  empty command ⇒ "" + degraded (inert)
 *   §R-9  per-tick timeout is clamped to the 5s hard cap (resolveTimeoutMs)
 *   §R-10 refreshInterval clamps UP to 1s; absent ⇒ undefined (event-driven)
 *
 * buildStatusPayload:
 *   §B-1  hook_event_name is ALWAYS "Status"
 *   §B-2  contract field SHAPE (nested model/workspace/cost/output_style/…)
 *   §B-3  missing fields are OMITTED (not nulled) — empty sub-objects dropped
 *   §B-4  NO secrets: the payload JSON carries no token/key/secret substring
 *
 * formatStatusOutput:
 *   §F-1  first-line + width truncate + ANSI reset correction (pure)
 */

import { describe, expect, test } from "bun:test"
import {
  buildStatusPayload,
  formatStatusOutput,
  HARD_CAP_MS,
  resolveRefreshIntervalMs,
  resolveTimeoutMs,
  runStatusCommand,
  type StatusPayload,
  type StatusSpawner,
  stripAnsi,
} from "../status-command-runner"

// ── deterministic spawner harness ────────────────────────────────────────────

interface FakeOpts {
  readonly stdout: string
  readonly exitCode?: number
  /** Never resolve `exited` until kill() — simulates a hung/slow command. */
  readonly hang?: boolean
}

/** Build a spawner that records the injected stdin and yields scripted output. */
const fakeSpawner = (
  opts: FakeOpts,
): { spawn: StatusSpawner; capturedStdin: () => string; killed: () => boolean } => {
  let stdinSeen = ""
  let wasKilled = false
  const spawn: StatusSpawner = (_argv, o) => {
    stdinSeen = new TextDecoder().decode(o.stdin)
    let resolveExit: (code: number) => void = () => {}
    const exited = new Promise<number>((res) => {
      resolveExit = res
      if (opts.hang !== true) res(opts.exitCode ?? 0)
    })
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(opts.stdout))
        controller.close()
      },
    })
    return {
      stdout,
      exited,
      kill: () => {
        wasKilled = true
        resolveExit(137)
      },
    }
  }
  return { spawn, capturedStdin: () => stdinSeen, killed: () => wasKilled }
}

const ESC = String.fromCharCode(27)
const samplePayload: StatusPayload = { hook_event_name: "Status", cwd: "/tmp" }

describe("buildStatusPayload", () => {
  test("§B-1 hook_event_name is always 'Status'", () => {
    expect(buildStatusPayload({}).hook_event_name).toBe("Status")
  })

  test("§B-2 contract field shape — nested model/workspace/cost/output_style", () => {
    const p = buildStatusPayload({
      sessionId: "s1",
      transcriptPath: "/t.jsonl",
      cwd: "/repo",
      modelId: "gpt-5",
      modelDisplayName: "GPT-5",
      currentDir: "/repo",
      projectDir: "/repo",
      addedDirs: ["/repo/sub"],
      gitWorktree: "/repo/.wt/x",
      version: "1.2.3",
      outputStyleName: "default",
      totalCostUsd: 0.42,
      totalDurationMs: 1000,
      totalApiDurationMs: 800,
      totalLinesAdded: 10,
      totalLinesRemoved: 2,
      contextWindow: 200000,
      exceeds200kTokens: false,
      fastMode: true,
      effortLevel: "high",
      thinkingEnabled: true,
    })
    expect(p.model).toEqual({ id: "gpt-5", display_name: "GPT-5" })
    expect(p.workspace).toEqual({
      current_dir: "/repo",
      project_dir: "/repo",
      added_dirs: ["/repo/sub"],
      git_worktree: "/repo/.wt/x",
    })
    expect(p.cost).toEqual({
      total_cost_usd: 0.42,
      total_duration_ms: 1000,
      total_api_duration_ms: 800,
      total_lines_added: 10,
      total_lines_removed: 2,
    })
    expect(p.output_style).toEqual({ name: "default" })
    expect(p.effort).toEqual({ level: "high" })
    expect(p.thinking).toEqual({ enabled: true })
    expect(p.context_window).toBe(200000)
    expect(p.exceeds_200k_tokens).toBe(false)
    expect(p.fast_mode).toBe(true)
  })

  test("§B-3 missing fields are omitted (empty sub-objects dropped)", () => {
    const p = buildStatusPayload({ cwd: "/x" })
    expect(p.cwd).toBe("/x")
    // No model/workspace/cost/effort/thinking keys at all (not null).
    const keys = Object.keys(p)
    expect(keys).toContain("hook_event_name")
    expect(keys).toContain("cwd")
    expect(keys).not.toContain("model")
    expect(keys).not.toContain("workspace")
    expect(keys).not.toContain("cost")
    expect(keys).not.toContain("effort")
    expect(keys).not.toContain("thinking")
    // Serialized form has no `null`.
    expect(JSON.stringify(p)).not.toContain("null")
  })

  test("§B-3b a partial sub-object keeps only the present keys", () => {
    const p = buildStatusPayload({ modelId: "m", totalCostUsd: 1 })
    expect(p.model).toEqual({ id: "m" })
    expect(p.cost).toEqual({ total_cost_usd: 1 })
    expect(p.model && "display_name" in p.model).toBe(false)
  })

  test("§B-4 NO secrets — payload JSON has no token/key/secret material", () => {
    // The view shape has no credential slot; even if a host passed token-ish
    // strings into legit fields they'd be visible, but our fields never carry
    // secrets. Assert the serialized payload contains none of the danger words
    // for a fully-populated benign view.
    const p = buildStatusPayload({
      cwd: "/repo",
      modelId: "gpt-5",
      totalCostUsd: 0.1,
      contextWindow: 1000,
    })
    const json = JSON.stringify(p).toLowerCase()
    for (const danger of ["api_key", "apikey", "bearer", "secret", "token", "password"]) {
      expect(json).not.toContain(danger)
    }
  })
})

describe("formatStatusOutput (pure)", () => {
  test("§F-1 first line only", () => {
    expect(formatStatusOutput("hello\nworld\n", 80)).toBe("hello")
    expect(formatStatusOutput("a\r\nb", 80)).toBe("a")
  })

  test("§F-1b plain truncation to width", () => {
    expect(formatStatusOutput("abcdefghij", 4)).toBe("abcd")
  })

  test("§F-1c width<=0 ⇒ no truncation", () => {
    expect(formatStatusOutput("abcdefghij", 0)).toBe("abcdefghij")
  })

  test("§F-1d ANSI does not count toward width; fits ⇒ untouched", () => {
    const colored = `${ESC}[31mRED${ESC}[0m`
    // visible width 3 < 80 ⇒ returned verbatim
    expect(formatStatusOutput(colored, 80)).toBe(colored)
  })

  test("§F-1e cut inside colored text ⇒ reset appended, visible width respected", () => {
    const colored = `${ESC}[31mABCDEFGHIJ${ESC}[0m`
    const out = formatStatusOutput(colored, 4)
    expect(stripAnsi(out)).toBe("ABCD")
    expect(out.endsWith(`${ESC}[0m`)).toBe(true)
  })
})

describe("runStatusCommand — fake spawner", () => {
  test("§R-1 the Status JSON is injected on stdin (fake captures it)", async () => {
    const h = fakeSpawner({ stdout: "ok\n" })
    await runStatusCommand({ command: "x" }, samplePayload, { spawn: h.spawn })
    const sent = JSON.parse(h.capturedStdin().trim())
    expect(sent.hook_event_name).toBe("Status")
    expect(sent.cwd).toBe("/tmp")
  })

  test("§R-2 stdout first line only", async () => {
    const h = fakeSpawner({ stdout: "line1\nline2\nline3" })
    const r = await runStatusCommand({ command: "x" }, samplePayload, { spawn: h.spawn, width: 80 })
    expect(r.text).toBe("line1")
    expect(r.degraded).toBe(false)
  })

  test("§R-3 ANSI passthrough when it fits", async () => {
    const colored = `${ESC}[32mgreen${ESC}[0m`
    const h = fakeSpawner({ stdout: `${colored}\n` })
    const r = await runStatusCommand({ command: "x" }, samplePayload, { spawn: h.spawn, width: 80 })
    expect(r.text).toBe(colored)
  })

  test("§R-4 truncate to width with reset correction", async () => {
    const h = fakeSpawner({ stdout: `${ESC}[31mABCDEFGHIJ${ESC}[0m\n` })
    const r = await runStatusCommand({ command: "x" }, samplePayload, { spawn: h.spawn, width: 4 })
    expect(stripAnsi(r.text)).toBe("ABCD")
    expect(r.text.endsWith(`${ESC}[0m`)).toBe(true)
  })

  test("§R-5 timeout ⇒ '' + degraded, child killed", async () => {
    const h = fakeSpawner({ stdout: "never\n", hang: true })
    const r = await runStatusCommand({ command: "x" }, samplePayload, { spawn: h.spawn, width: 80 })
    expect(r.text).toBe("")
    expect(r.degraded).toBe(true)
    expect(h.killed()).toBe(true)
  })

  test("§R-6 non-zero exit ⇒ degraded, but stdout surfaced", async () => {
    const h = fakeSpawner({ stdout: "partial\n", exitCode: 2 })
    const r = await runStatusCommand({ command: "x" }, samplePayload, { spawn: h.spawn, width: 80 })
    expect(r.text).toBe("partial")
    expect(r.degraded).toBe(true)
  })

  test("§R-7 spawn error ⇒ '' + degraded (never throws)", async () => {
    const throwing: StatusSpawner = () => {
      throw new Error("ENOENT")
    }
    const r = await runStatusCommand({ command: "x" }, samplePayload, { spawn: throwing })
    expect(r.text).toBe("")
    expect(r.degraded).toBe(true)
  })

  test("§R-8 empty command ⇒ '' + degraded (inert, no spawn)", async () => {
    let spawned = false
    const spy: StatusSpawner = (_a, _o) => {
      spawned = true
      return {
        stdout: null,
        exited: Promise.resolve(0),
        kill: () => {},
      }
    }
    for (const cmd of ["", "   ", [] as string[]]) {
      const r = await runStatusCommand({ command: cmd }, samplePayload, { spawn: spy })
      expect(r.text).toBe("")
      expect(r.degraded).toBe(true)
    }
    expect(spawned).toBe(false)
  })
})

describe("clamp helpers", () => {
  test("§R-9 resolveTimeoutMs clamps to (0, HARD_CAP] / defaults", () => {
    expect(resolveTimeoutMs(undefined)).toBe(500)
    expect(resolveTimeoutMs(0)).toBe(500)
    expect(resolveTimeoutMs(-5)).toBe(500)
    expect(resolveTimeoutMs(Number.NaN)).toBe(500)
    expect(resolveTimeoutMs(200)).toBe(200)
    expect(resolveTimeoutMs(999999)).toBe(HARD_CAP_MS)
  })

  test("§R-10 resolveRefreshIntervalMs clamps up to 1s; absent ⇒ undefined", () => {
    expect(resolveRefreshIntervalMs(undefined)).toBeUndefined()
    expect(resolveRefreshIntervalMs(0)).toBeUndefined()
    expect(resolveRefreshIntervalMs(-1)).toBeUndefined()
    expect(resolveRefreshIntervalMs(500)).toBe(1000)
    expect(resolveRefreshIntervalMs(1000)).toBe(1000)
    expect(resolveRefreshIntervalMs(3000)).toBe(3000)
  })
})

describe("runStatusCommand — REAL subprocess (args-based, no shell)", () => {
  test("§R-1(real) stdin JSON round-trips through `cat`", async () => {
    // `cat` echoes stdin to stdout; first line is the single-line JSON we wrote.
    const r = await runStatusCommand({ command: ["cat"] }, samplePayload, { width: 4000 })
    expect(r.degraded).toBe(false)
    const parsed = JSON.parse(r.text.trim())
    expect(parsed.hook_event_name).toBe("Status")
    expect(parsed.cwd).toBe("/tmp")
  })

  test("§R-3(real) a script printing ANSI passes the codes through", async () => {
    const colored = `${ESC}[36mhi${ESC}[0m`
    const r = await runStatusCommand(
      { command: ["printf", `${colored}\\nSECONDLINE\\n`] },
      samplePayload,
      { width: 80 },
    )
    // first line only + ANSI intact
    expect(r.text).toBe(colored)
    expect(stripAnsi(r.text)).toBe("hi")
  })

  test("§R-7(real) a nonexistent binary degrades to '' (no throw)", async () => {
    const r = await runStatusCommand(
      { command: ["this-binary-does-not-exist-xyzzy"] },
      samplePayload,
    )
    expect(r.text).toBe("")
    expect(r.degraded).toBe(true)
  })
})
