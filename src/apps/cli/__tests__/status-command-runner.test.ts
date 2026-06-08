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
  statusChildEnv,
  stripAnsi,
  stripStatusAnsi,
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

/** A TRULY dead child: `kill()` does NOTHING (does not resolve `exited`) and
 *  stdout NEVER closes. Both `handle.exited` and `readAll(stdout)` hang forever,
 *  so ONLY a wall-clock race can settle the runner (finding 6 — the old fake's
 *  `kill()` resolved `exited`, masking the unbounded hang). */
const deadSpawner = (): { spawn: StatusSpawner; killed: () => boolean } => {
  let wasKilled = false
  const spawn: StatusSpawner = () => ({
    // A stream whose `start` enqueues nothing and never closes ⇒ read() pends.
    stdout: new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue, never close */
      },
    }),
    // `exited` that NEVER resolves.
    exited: new Promise<number>(() => {}),
    kill: () => {
      wasKilled = true // recorded, but deliberately does NOT settle anything
    },
  })
  return { spawn, killed: () => wasKilled }
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

  test("§B-3 non-finite numeric facts are OMITTED, never serialized as null", () => {
    // JSON.stringify(NaN) / JSON.stringify(Infinity) both yield `null`, which
    // breaks the documented "omit rather than null" invariant — a CC script
    // branches on key presence and would mistake `null` for a real value.
    const p = buildStatusPayload({
      totalCostUsd: Number.NaN,
      totalDurationMs: Number.POSITIVE_INFINITY,
      totalApiDurationMs: Number.NEGATIVE_INFINITY,
      contextWindow: Number.POSITIVE_INFINITY,
    })
    // The serialized payload must contain NO `null` at all …
    expect(JSON.stringify(p)).not.toContain("null")
    // … and the non-finite keys must be ABSENT (not present-null).
    expect(p.cost).toBeUndefined() // every cost field was non-finite ⇒ dropped
    expect(Object.keys(p)).not.toContain("context_window")
  })

  test("§B-3 a finite number survives alongside a non-finite sibling", () => {
    const p = buildStatusPayload({
      totalCostUsd: 0.5,
      totalDurationMs: Number.NaN,
      contextWindow: 1000,
    })
    expect(p.cost).toEqual({ total_cost_usd: 0.5 })
    expect(p.context_window).toBe(1000)
    expect(JSON.stringify(p)).not.toContain("null")
  })

  test("§B-3b a partial sub-object keeps only the present keys", () => {
    const p = buildStatusPayload({ modelId: "m", totalCostUsd: 1 })
    expect(p.model).toEqual({ id: "m" })
    expect(p.cost).toEqual({ total_cost_usd: 1 })
    expect(p.model && "display_name" in p.model).toBe(false)
  })

  test("§B-4 NON-tautological: explicit secret fields are DROPPED (allowlist, not denylist)", () => {
    // The previous §B-4 was tautological — benign input never contained the
    // danger words, so "no secrets in output" was trivially true. Here we FEED
    // explicit secret-shaped fields alongside the known ones (cast through `any`
    // to bypass the typed view). If `buildStatusPayload` were a passthrough /
    // denylist it would leak them; because it is an ALLOWLIST (copies ONLY named
    // fields), every smuggled secret must be ABSENT from the serialized payload.
    const hostile = {
      // legit fields that SHOULD survive
      cwd: "/repo",
      modelId: "gpt-5",
      totalCostUsd: 0.1,
      contextWindow: 1000,
      // smuggled credentials that MUST NOT survive
      apiKey: "sk-SECRET",
      ANTHROPIC_API_KEY: "sk-ant-LEAK",
      OPENAI_API_KEY: "sk-openai-LEAK",
      authorization: "Bearer xyz",
      password: "hunter2",
      token: "ghp_LEAKLEAK",
      env: { AWS_SECRET_ACCESS_KEY: "leak", HOME: "/root" },
    }
    const p = buildStatusPayload(hostile as unknown as Parameters<typeof buildStatusPayload>[0])
    const json = JSON.stringify(p)
    // The legit allowlisted facts DID survive (proves we copied, not just nuked).
    expect(p.cwd).toBe("/repo")
    expect(p.model).toEqual({ id: "gpt-5" })
    // EVERY smuggled secret value + key is absent.
    for (const leak of [
      "sk-SECRET",
      "sk-ant-LEAK",
      "sk-openai-LEAK",
      "Bearer xyz",
      "hunter2",
      "ghp_LEAKLEAK",
      "AWS_SECRET_ACCESS_KEY",
      "apiKey",
      "ANTHROPIC_API_KEY",
      "authorization",
      "password",
    ]) {
      expect(json).not.toContain(leak)
    }
    // And no `env` / token / apikey KEY made it into the payload object.
    for (const key of ["apiKey", "ANTHROPIC_API_KEY", "authorization", "password", "token", "env"]) {
      expect(Object.keys(p)).not.toContain(key)
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

  test("§F fits-under-width with an UNCLOSED SGR ⇒ reset appended (no bleed)", () => {
    // An open background+fg SGR that fits under width must STILL be reset, or it
    // bleeds color into the prompt printed below the status line.
    const out = formatStatusOutput(`${ESC}[41;97mALERT`, 80)
    expect(stripAnsi(out)).toBe("ALERT")
    expect(out.endsWith(`${ESC}[0m`)).toBe(true)
  })

  test("§F already-reset line is NOT double-reset", () => {
    const closed = `${ESC}[31mok${ESC}[0m`
    expect(formatStatusOutput(closed, 80)).toBe(closed)
  })

  test("§F width<=0 with an unclosed SGR ⇒ reset appended (no bleed)", () => {
    const out = formatStatusOutput(`${ESC}[41;97mNOWIDTH`, 0)
    expect(stripAnsi(out)).toBe("NOWIDTH")
    expect(out.endsWith(`${ESC}[0m`)).toBe(true)
  })

  test("§F plain text (no SGR) is never reset-padded", () => {
    expect(formatStatusOutput("plain", 80)).toBe("plain")
    expect(formatStatusOutput("plain", 0)).toBe("plain")
  })

  test("§F OSC-8 hyperlink fitting under width ⇒ terminated, no bare escape", () => {
    // OSC-8 hyperlink: ESC ] 8 ; ; URL ST  TEXT  ESC ] 8 ; ; ST  (ST = ESC \).
    const ST = `${ESC}\\`
    const link = `${ESC}]8;;https://x${ST}LINK${ESC}]8;;${ST}`
    const out = formatStatusOutput(link, 80)
    // Visible width counts only LINK (4 cols), well under 80 ⇒ returned intact.
    expect(out).not.toMatch(/\x1b\]$/) // no dangling bare OSC introducer
    expect(out).not.toMatch(/\x1b\[$/) // no dangling bare CSI introducer
    // The visible text survives.
    expect(out.includes("LINK")).toBe(true)
  })

  test("§F truncation never leaves a bare/unterminated escape (OSC + CSI)", () => {
    const ST = `${ESC}\\`
    // An OSC-8 hyperlink wrapping a long label, plus trailing SGR color — cut at
    // a width that lands INSIDE the link payload. Result must not end mid-escape.
    const input = `${ESC}]8;;https://example.com${ST}${ESC}[31mABCDEFGHIJKLMNOP${ESC}[0m`
    const out = formatStatusOutput(input, 5)
    // Exactly `width` visible columns — measured OSC-aware (the SGR-only
    // `stripAnsi` would miscount the hyperlink URL as visible text).
    expect(stripStatusAnsi(out).length).toBe(5)
    // No dangling escape introducer of any kind.
    expect(out.endsWith(ESC)).toBe(false)
    expect(out).not.toMatch(/\x1b\[$/)
    expect(out).not.toMatch(/\x1b\]$/)
    expect(out).not.toMatch(/\x1b\][^\x07\x1b]*$/) // no unterminated OSC tail
  })

  test("§F a truncated/incomplete CSI in input is not split mid-sequence", () => {
    // Input ends with an incomplete CSI (no final letter). The tokenizer must
    // consume it as one unit (or drop it) — never emit a half escape.
    const input = `${ESC}[31mABCDEFGH${ESC}[3` // dangling `ESC[3`
    const out = formatStatusOutput(input, 4)
    expect(stripAnsi(out)).toBe("ABCD")
    expect(out).not.toMatch(/\x1b\[3$/) // the dangling CSI must not leak out
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

  test("§R-5b wall-clock cap settles even when child NEVER closes/exits", async () => {
    // The non-vacuous version of §R-5: a child whose `kill()` does NOT resolve
    // `exited` and whose stdout NEVER closes. Without a wall-clock race the
    // runner's `Promise.all` would hang past the 5s cap forever. A short injected
    // `hardCapMs` proves the runner ALWAYS settles to {text:'', degraded:true}
    // and kills the child — within the cap + slack.
    const d = deadSpawner()
    const start = Date.now()
    const r = await runStatusCommand({ command: "x" }, samplePayload, {
      spawn: d.spawn,
      width: 80,
      hardCapMs: 30,
    })
    const elapsed = Date.now() - start
    expect(r.text).toBe("")
    expect(r.degraded).toBe(true)
    expect(d.killed()).toBe(true)
    // Settled near the cap, NOT at the 5s hard cap and NOT forever.
    expect(elapsed).toBeLessThan(2000)
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

  test("§SEC(real) child does NOT inherit parent secrets (scrubEnv chokepoint)", async () => {
    // FAITHFUL leak test: the secret must be present in the env of the process
    // that calls `runStatusCommand` AT START (Bun snapshots env at spawn, so a
    // runtime `process.env[K]=…` would NOT reach an inherit-all child — and would
    // make this test vacuous). So we spawn a NESTED bun runner with the secret in
    // ITS env, and have it invoke the real default spawner. The buggy version
    // (no `env` → inherit-all) leaks 'sk-LEAK'; the scrubbed version prints "".
    const driver = `
      import { runStatusCommand } from ${JSON.stringify(`${import.meta.dir}/../status-command-runner`)}
      const r = await runStatusCommand(
        { command: ["sh", "-c", "printf '%s' \\"$MY_FAKE_SECRET\\""] },
        { hook_event_name: "Status" },
        { width: 8000 },
      )
      process.stdout.write("CHILDSAW:" + r.text)
    `
    const proc = Bun.spawn(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(driver),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, MY_FAKE_SECRET: "sk-LEAK" },
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain("CHILDSAW:") // the nested runner actually ran
    expect(out).not.toContain("sk-LEAK") // …and the secret never reached the grandchild
  })

  test("§SEC statusChildEnv carries only allowlisted keys, no secret names", () => {
    // Unit-level proof the env is an ALLOWLIST (not a denylist): the returned
    // record's keys are a subset of the shared allowlist, and obviously-secret
    // names never appear even if present in the parent env.
    const env = statusChildEnv()
    const ALLOWED = new Set([
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "TZ",
      "TERM",
      "TMPDIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "VIRTUAL_ENV",
    ])
    for (const k of Object.keys(env)) expect(ALLOWED.has(k)).toBe(true)
    for (const danger of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
    ]) {
      expect(Object.keys(env)).not.toContain(danger)
    }
  })

  test("§SEC(real) child KEEPS a minimal safe env (PATH survives)", async () => {
    // Scrubbing must not nuke the safe baseline — PATH (and friends) is on the
    // allowlist so the script can still find binaries.
    const r = await runStatusCommand(
      { command: ["sh", "-c", 'printf "%s" "$PATH"'] },
      samplePayload,
      { width: 8000 },
    )
    expect(r.degraded).toBe(false)
    expect(r.text.length).toBeGreaterThan(0)
  })
})
