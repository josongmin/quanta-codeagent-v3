/**
 * P26 — headless `--output-format` end-to-end through the REAL `runMode`.
 *
 * Drives the headless preset with a hermetic `seams.runAgent` that emits a
 * representative AgentEvent trajectory INTO `cfg.stream` (whatever the preset
 * wired), capturing the real `process.stdout` bytes. Proves:
 *   (a) `stream-json` → every stdout line parses as JSON + round-trips the codec
 *       (the headless machine contract), and the final human answer is NOT
 *       printed to stdout (it would corrupt the stream).
 *   (b) absent flag / `text` → the structured sink is NOT wired (cfg.stream is
 *       the caller's stream), and the preset writes NOTHING to stdout (the
 *       legacy text path routes the final answer to stderr via `logger`) —
 *       byte-identical default.
 *   (c) `json` → exactly ONE well-formed top-level JSON value on stdout.
 */
import { describe, expect, test } from "bun:test"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { runMode } from "@/../src/apps/agent/mode-presets/headless"
import type { AgentConfig, AgentOutcome } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import { decodeSessionEvent, SESSION_PROTOCOL_VERSION } from "@/protocol/session"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

const fakeLlm: LLMPort = { model: "test", stream: async function* () {} } as unknown as LLMPort
const callerStream: StreamPort = { emit: () => undefined }

const TRAJECTORY: AgentEvent[] = [
  { type: "session_start" },
  { type: "turn_start", turn: 1 },
  { type: "tool_call", id: "t1", name: "bash", input: { cmd: "ls" } },
  { type: "tool_result", id: "t1", name: "bash", ok: true, preview: "ok" },
  { type: "done", reason: "completed", turns: 1 },
]

const finalAnswer: Message = {
  role: "assistant",
  content: [{ type: "text", text: "THE-FINAL-ANSWER" }],
}

const baseReq = (over: Partial<AssembleRequest> = {}): AssembleRequest => ({
  mode: "headless",
  base: {
    llm: fakeLlm,
    registry: new ToolRegistry(defaultTools),
    stream: callerStream,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 5,
    signal: new AbortController().signal,
  },
  headless: { prompt: "do the thing" },
  ...over,
})

/** Run `runMode` while capturing real `process.stdout.write` bytes. The seam
 *  `runAgent` emits the trajectory into the cfg.stream the preset wired, then
 *  returns an outcome whose last assistant message is `finalAnswer`. */
const runCapturingStdout = async (
  req: Partial<AssembleRequest>,
): Promise<{ stdout: string; cfgStream: StreamPort | undefined }> => {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  let cfgStream: StreamPort | undefined
  // biome-ignore lint/suspicious/noExplicitAny: test-only stdout interposer.
  ;(process.stdout as any).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const seams = {
      runAgent: async (cfg: AgentConfig): Promise<AgentOutcome> => {
        cfgStream = cfg.stream
        for (const e of TRAJECTORY) cfg.stream?.emit(e)
        return { reason: "completed", turns: 1, messages: [finalAnswer] }
      },
    }
    await runMode(baseReq({ ...req, seams }))
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore interposer.
    ;(process.stdout as any).write = orig
  }
  return { stdout: chunks.join(""), cfgStream }
}

describe("headless e2e — (a) stream-json machine contract on stdout", () => {
  test("each stdout line parses as JSON + codec round-trips; final answer NOT on stdout", async () => {
    const { stdout } = await runCapturingStdout({
      headless: { prompt: "do the thing", output: "stream-json" },
    })
    const lines = stdout.split("\n").filter((l) => l.length > 0)
    expect(lines.length).toBe(5)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { version: string }
      expect(parsed.version).toBe(SESSION_PROTOCOL_VERSION)
      // full codec round-trip.
      decodeSessionEvent(line)
    }
    // The human final-answer must NOT leak into the jq-parseable stream.
    expect(stdout).not.toContain("THE-FINAL-ANSWER")
  })
})

describe("headless e2e — (b) text / absent ⇒ byte-identical default", () => {
  test("absent flag: structured sink NOT wired (cfg.stream is caller's) and stdout is empty", async () => {
    const { stdout, cfgStream } = await runCapturingStdout({
      headless: { prompt: "do the thing" },
    })
    // The preset kept the caller-supplied stream (no StreamJsonSink injection).
    expect(cfgStream).toBe(callerStream)
    // The final answer goes to stderr via logger — stdout stays byte-identical
    // (empty, since the caller's stream is a no-op recorder).
    expect(stdout).toBe("")
  })

  test("output:'text' behaves identically to absent", async () => {
    const { stdout, cfgStream } = await runCapturingStdout({
      headless: { prompt: "do the thing", output: "text" },
    })
    expect(cfgStream).toBe(callerStream)
    expect(stdout).toBe("")
  })
})

describe("headless e2e — (c) json ⇒ one top-level JSON value", () => {
  test("stdout is exactly one well-formed JSON array of session events", async () => {
    const { stdout } = await runCapturingStdout({
      headless: { prompt: "do the thing", output: "json" },
    })
    const trimmed = stdout.trimEnd()
    // Exactly one top-level value: a single JSON.parse over the whole stdout.
    const arr = JSON.parse(trimmed) as unknown[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr.length).toBe(5)
    for (const el of arr) decodeSessionEvent(JSON.stringify(el))
    expect(stdout).not.toContain("THE-FINAL-ANSWER")
  })

  test("include-partial surfaces turn.output.delta in the json array", async () => {
    const chunks: string[] = []
    const orig = process.stdout.write.bind(process.stdout)
    // biome-ignore lint/suspicious/noExplicitAny: test-only stdout interposer.
    ;(process.stdout as any).write = (c: unknown): boolean => {
      chunks.push(String(c))
      return true
    }
    try {
      const seams = {
        runAgent: async (cfg: AgentConfig): Promise<AgentOutcome> => {
          cfg.stream?.emit({ type: "assistant_text", delta: "partial!" })
          cfg.stream?.emit({ type: "done", reason: "completed", turns: 1 })
          return { reason: "completed", turns: 1, messages: [finalAnswer] }
        },
      }
      await runMode(
        baseReq({ headless: { prompt: "x", output: "json", includePartial: true }, seams }),
      )
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore interposer.
      ;(process.stdout as any).write = orig
    }
    const arr = JSON.parse(chunks.join("").trimEnd()) as Array<{ payload: { type: string } }>
    const types = arr.map((el) => el.payload.type)
    expect(types).toContain("turn.output.delta")
    expect(types).toContain("turn.completed")
  })
})
