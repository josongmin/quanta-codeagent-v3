/**
 * `quanta serve --stdio` e2e HELLGATE (jul-16 transport-unified SDK, ticket 02).
 *
 * REAL child processes: every test here spawns the ACTUAL CLI entry
 * (`src/apps/cli/index.ts`) with `bun` and speaks session.v1 over the child's
 * stdin/stdout — either through the production SDK door (`connect()` +
 * `transports.stdio`, ticket 01) or through a raw pipe speaker (for the
 * stdout-purity / EOF / SIGTERM lifecycle assertions the spawn transport's
 * ownership would hide). The LLM is the env-driven deterministic replay
 * cassette (`QUANTA_LLM_REPLAY`, pinned request hash) — a REAL agent loop with
 * real default tools, no network, no stub server.
 *
 * Red-on-injection wiring (each is a live tripwire, not decoration):
 *  - GATE: the OFF test asserts the child REFUSES (exit 64 + guidance) and
 *    `connect()` fails TYPED with the child's last words. Delete the
 *    `QUANTA_SERVE_STDIO` check in `serve-stdio-cmd.ts` ⇒ the OFF child serves
 *    ⇒ `connect()` resolves ⇒ RED.
 *  - STAMP: the core test asserts `snapshot.capabilities.transport === "stdio"`
 *    AND `!== "inproc"` (ticket 02 acceptance "다름이 정답"). Delete the
 *    `sessionTransport` seam (base.ts falls back to the hardcoded "inproc")
 *    ⇒ RED.
 *  - PURITY: the checker that proves every stdout line is a decodable
 *    session.v1 frame is itself proven non-vacuous by the POLLUTER control
 *    (a wrapper entry that writes garbage to stdout before booting the same
 *    server): the SAME checker must flag it. A checker that cannot see
 *    pollution fails the control ⇒ RED.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  encodeSessionTransportMessage,
  SessionHandleClosedError,
  type SessionTransportMessage,
  SessionTurnCorrelationLostError,
  tryDecodeSessionTransportMessage,
} from "@/ipc/session"
import type { SessionEvent } from "@/protocol/session"
import { connect, transports } from "@/sdk"

const REPO_ROOT = new URL("../../../", import.meta.url).pathname
const CLI_ENTRY = join(REPO_ROOT, "src", "apps", "cli", "index.ts")
const POLLUTER_ENTRY = join(
  REPO_ROOT,
  "tests",
  "unit",
  "cli",
  "fixtures",
  "serve-stdio-polluted-entry.ts",
)
const BUN = process.execPath

/* ------------------------------------------------------------------ helpers */

/** One-turn text cassette (factory pins the request hash to "replay"). */
const textCassette = (marker: string): string =>
  `${JSON.stringify({
    id: "replay",
    events: [
      { type: "text_delta", delta: marker },
      { type: "usage", inputTokens: 10, outputTokens: 5, model: "replay" },
      { type: "message_stop", stop_reason: "end_turn" },
    ],
  })}\n`

const toolCallReplay = (id: string, command: string): string =>
  JSON.stringify({
    id: "replay",
    events: [
      { type: "tool_use_start", id, name: "bash" },
      { type: "tool_use_end", id, input: { command } },
      { type: "message_stop", stop_reason: "tool_use" },
    ],
  })

const completedReplay = (doneMarker: string): string =>
  JSON.stringify({
    id: "replay",
    events: [
      { type: "text_delta", delta: doneMarker },
      { type: "message_stop", stop_reason: "end_turn" },
    ],
  })

/** Approval-suspension cassette: turn 1 calls bash (parks on approval), the
 *  post-approval re-run calls bash again (consumes the lease, tool EXECUTES),
 *  then the loop's next stream completes with text. */
const approvalCassette = (command: string, doneMarker: string): string =>
  `${[
    toolCallReplay("t1", command),
    toolCallReplay("t1b", command),
    completedReplay(doneMarker),
  ].join("\n")}\n`

/** Two sequential approval parks. Each command is proposed once to mint its
 *  approval and once again after the wire response to consume the exact lease. */
const multipleApprovalCassette = (
  firstCommand: string,
  secondCommand: string,
  doneMarker: string,
): string =>
  `${[
    toolCallReplay("t1", firstCommand),
    toolCallReplay("t1b", firstCommand),
    toolCallReplay("t2", secondCommand),
    toolCallReplay("t2b", secondCommand),
    completedReplay(doneMarker),
  ].join("\n")}\n`

/** ENTIRE child env (the spawn transport passes it VERBATIM — nothing is
 *  auto-injected, so enabling the maturity gate here is the test's explicit
 *  act, exactly the contract the SDK documents). */
const childEnv = (extra: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v
  }
  // Network-safety belt: no real provider credentials ever reach the child —
  // every serving test pins `QUANTA_LLM_REPLAY`, so a key would be unused
  // anyway, but a REGRESSION (e.g. the replay hook lost) must fail loud on a
  // missing key rather than silently hit a real API.
  delete base.ANTHROPIC_API_KEY
  delete base.OPENAI_API_KEY
  delete base.QUANTA_PROVIDER
  // Replay still crosses the real provider bootstrap, which requires a
  // non-empty credential before the cassette adapter takes over. Use an
  // intentionally invalid test credential: if replay wiring regresses, the
  // child fails authentication instead of reaching a paid API with a real key.
  const replayBootstrap =
    extra.QUANTA_LLM_REPLAY === undefined
      ? {}
      : { QUANTA_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }
  return { ...base, ...replayBootstrap, ...extra }
}

const tempDirs: string[] = []
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "serve-stdio-e2e-"))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Raw-pipe speaker: spawn the serve child directly (NOT via the spawn
 *  transport) so the test can see EVERY raw stdout byte (purity) and drive
 *  stdin EOF / SIGTERM itself (lifecycle). */
interface RawServeChild {
  readonly child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>
  readonly lines: string[]
  send(message: SessionTransportMessage): void
  /** Resolve when a decoded frame satisfies `pred` (scans past + future). */
  waitFor<T>(pred: (m: SessionTransportMessage) => T | undefined): Promise<T>
  stderrText(): Promise<string>
}

interface RawServeOutputState {
  readonly lines: string[]
  readonly decoded: SessionTransportMessage[]
  readonly waiters: Array<() => void>
}

const wakeRawServeWaiters = (waiters: Array<() => void>): void => {
  for (const wake of waiters.splice(0)) wake()
}

const captureRawServeLine = (state: RawServeOutputState, line: string): void => {
  if (line.length === 0) return
  state.lines.push(line)
  const message = tryDecodeSessionTransportMessage(line)
  if (message !== undefined) state.decoded.push(message)
}

const pumpRawServeStdout = async (
  stdout: ReadableStream<Uint8Array>,
  state: RawServeOutputState,
): Promise<void> => {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        captureRawServeLine(state, buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
      }
      wakeRawServeWaiters(state.waiters)
    }
  } catch {
    // Child died — pending waiters are woken below.
  }
  wakeRawServeWaiters(state.waiters)
}

const nextMatchingRawMessage = <T>(
  decoded: readonly SessionTransportMessage[],
  cursor: number,
  pred: (message: SessionTransportMessage) => T | undefined,
): { readonly cursor: number; readonly hit?: T } => {
  let nextCursor = cursor
  while (nextCursor < decoded.length) {
    const message = decoded[nextCursor]
    nextCursor += 1
    if (message === undefined) continue
    const hit = pred(message)
    if (hit !== undefined) return { cursor: nextCursor, hit }
  }
  return { cursor: nextCursor }
}

const waitForRawMessage = async <T>(
  child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>,
  state: RawServeOutputState,
  pred: (message: SessionTransportMessage) => T | undefined,
): Promise<T> => {
  let cursor = 0
  while (true) {
    const scan = nextMatchingRawMessage(state.decoded, cursor, pred)
    cursor = scan.cursor
    if (scan.hit !== undefined) return scan.hit
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `serve child exited (code=${child.exitCode} signal=${child.signalCode}) before the expected frame; lines=${JSON.stringify(state.lines)}`,
      )
    }
    await new Promise<void>((resolve) => {
      state.waiters.push(resolve)
      setTimeout(resolve, 50)
    })
  }
}

const spawnRawServe = (args: {
  readonly entry?: string
  readonly argv?: readonly string[]
  readonly env: Record<string, string>
  readonly cwd: string
}): RawServeChild => {
  const child = Bun.spawn({
    cmd: [BUN, args.entry ?? CLI_ENTRY, ...(args.argv ?? ["serve", "--stdio"])],
    cwd: args.cwd,
    env: args.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const lines: string[] = []
  const outputState: RawServeOutputState = { lines, decoded: [], waiters: [] }
  void pumpRawServeStdout(child.stdout, outputState)
  return {
    child,
    lines,
    send(message) {
      child.stdin.write(`${encodeSessionTransportMessage(message)}\n`)
      void child.stdin.flush()
    },
    async waitFor(pred) {
      return await waitForRawMessage(child, outputState, pred)
    },
    async stderrText() {
      return await new Response(child.stderr).text()
    },
  }
}

/** Drive the raw child through the discovery handshake and one full turn;
 *  returns every raw stdout line observed. */
const runRawTurn = async (raw: RawServeChild): Promise<string[]> => {
  raw.send({ kind: "connect", sessionId: "ui-session" })
  const canonical = await raw.waitFor((m) =>
    m.kind === "rejected" && m.reason === "session_id_mismatch" ? m.sessionId : undefined,
  )
  if (canonical === undefined) throw new Error("discovery reject carried no canonical session id")
  raw.send({ kind: "connect", sessionId: canonical })
  await raw.waitFor((m) => (m.kind === "snapshot" ? true : undefined))
  raw.send({
    kind: "command",
    command: {
      type: "input.append",
      commandId: "raw-append",
      sessionId: canonical,
      issuedAt: new Date().toISOString(),
      text: "run the purity turn",
    },
  })
  raw.send({
    kind: "command",
    command: {
      type: "turn.run",
      commandId: "raw-run",
      sessionId: canonical,
      issuedAt: new Date().toISOString(),
    },
  })
  await raw.waitFor((m) =>
    m.kind === "event" && m.event.type === "turn.completed" ? true : undefined,
  )
  return [...raw.lines]
}

/** THE stdout-purity checker: a line is legal iff it decodes as a session.v1
 *  transport frame. Returns the offending lines (empty = pure). */
const impureStdoutLines = (lines: readonly string[]): string[] =>
  lines.filter((line) => tryDecodeSessionTransportMessage(line) === undefined)

/* -------------------------------------------------------------------- tests */

describe("quanta serve --stdio — spawned session.v1 server (ticket 02)", () => {
  test(
    "CORE: connect() → append → turn.run → awaitTurnEnd over a REAL spawned child; capabilities.transport === 'stdio' (≠ inproc)",
    async () => {
      const dir = mkTmp()
      const cassette = join(dir, "cassette.jsonl")
      writeFileSync(cassette, textCassette("SERVE_E2E_TEXT ok"))
      const session = await connect({
        transport: transports.stdio({
          command: [BUN, CLI_ENTRY, "serve", "--stdio", "--cwd", dir],
          env: childEnv({ QUANTA_SERVE_STDIO: "1", QUANTA_LLM_REPLAY: cassette }),
          cwd: dir,
        }),
      })
      try {
        const snapshot = await session.snapshot()
        expect(snapshot).toBeDefined()
        // STAMP seam (red-on-injection: remove the sessionTransport seam and
        // base.ts hardcodes "inproc" again ⇒ both asserts go RED).
        expect(snapshot?.snapshot.capabilities.transport).toBe("stdio")
        expect(snapshot?.snapshot.capabilities.transport).not.toBe("inproc")

        await session.input.append("say the marker")
        await session.turn.run()
        const end = await session.awaitTurnEnd()
        expect(end.type).toBe("turn.completed")
        if (end.type === "turn.completed") {
          expect(end.assistantText ?? "").toContain("SERVE_E2E_TEXT")
        }
      } finally {
        await session.close()
      }
    },
    { timeout: 90_000 },
  )

  // FOLLOW-UP (docs/plans/jul-16-transport-unified-sdk/audit-followups-jul17.md
  // "serve wire-approval delegation"): serve --stdio가 approval을 WIRE 클라
  // (`connect({onApproval})`)에게 위임하려면 kernel `awaiting_approval` +
  // `approval.requested` wire 이벤트 → `approval.respond` 재개 경로가 필요하다.
  // 현재 headless approval은 W1-A inline auto-approve(QUANTA_INLINE_APPROVAL_
  // RESOLVER=1) 또는 OFF deny 두 모드뿐 — "wire-defer"(onConfirm이 deny 대신
  // wire respond를 대기하는 resolver) 3번째 모드가 미구현이라 자식이
  // approval.requested를 wire로 내보내지 않아 `onApproval`이 호출되지 않는다.
  // CLI attach가 daemon 세션에서 쓰는 그 flow와 동형. 서버 핵심(gate/stamp/
  // EOF/SIGTERM/stdout-purity/기본 턴) 7개는 완성; 이 위임 배선은 kernel
  // approval 경로를 건드리는 별도 작업으로 분리.
  test(
    "APPROVAL round-trip: a gated bash tool parks the turn; onApproval approves; the tool REALLY executes (marker file) and the turn completes",
    async () => {
      const dir = mkTmp()
      const cassette = join(dir, "cassette.jsonl")
      const marker = join(dir, "approval-marker")
      writeFileSync(cassette, approvalCassette(`touch ${marker}`, "SERVE_E2E_DONE"))
      const approvals: string[] = []
      const session = await connect({
        transport: transports.stdio({
          command: [BUN, CLI_ENTRY, "serve", "--stdio", "--cwd", dir],
          env: childEnv({ QUANTA_SERVE_STDIO: "1", QUANTA_LLM_REPLAY: cassette }),
          cwd: dir,
        }),
        onApproval: async (approval) => {
          approvals.push(approval.approvalId)
          return "approve"
        },
      })
      const seen: SessionEvent[] = []
      session.subscribe((event) => {
        seen.push(event)
      })
      try {
        await session.input.append("do the gated thing")
        await session.turn.run()
        const end = await session.awaitTurnEnd()
        expect(end.type).toBe("turn.completed")
        if (end.type === "turn.completed") {
          expect(end.assistantText ?? "").toContain("SERVE_E2E_DONE")
        }
        // The park→respond→re-issue actually happened on the wire…
        expect(approvals.length).toBe(1)
        expect(seen.some((e) => e.type === "approval.requested")).toBe(true)
        // …and the REAL tool effect landed (not a scripted echo).
        expect(existsSync(marker)).toBe(true)
      } finally {
        await session.close()
      }
    },
    { timeout: 90_000 },
  )

  test(
    "APPROVAL deny: exact wire decision settles awaitTurnEnd typed and the tool NEVER executes",
    async () => {
      const dir = mkTmp()
      const cassette = join(dir, "cassette.jsonl")
      const marker = join(dir, "deny-must-not-exist")
      writeFileSync(cassette, approvalCassette(`touch ${marker}`, "UNREACHABLE"))
      const approvals: string[] = []
      const session = await connect({
        transport: transports.stdio({
          command: [BUN, CLI_ENTRY, "serve", "--stdio", "--cwd", dir],
          env: childEnv({ QUANTA_SERVE_STDIO: "1", QUANTA_LLM_REPLAY: cassette }),
          cwd: dir,
        }),
        onApproval: async (approval) => {
          approvals.push(approval.approvalId)
          return "deny"
        },
      })
      try {
        await session.input.append("deny the gated thing")
        await session.turn.run()
        let failure: unknown
        try {
          await session.awaitTurnEnd()
        } catch (error) {
          failure = error
        }
        expect(failure).toBeInstanceOf(SessionTurnCorrelationLostError)
        expect((failure as SessionTurnCorrelationLostError).reason).toBe("approval_denied")
        expect(approvals).toHaveLength(1)
        expect(existsSync(marker)).toBe(false)
      } finally {
        await session.close()
      }
    },
    { timeout: 90_000 },
  )

  test(
    "MULTIPLE approvals: two sequential wire parks resolve exact ids; both real tool effects land once",
    async () => {
      const dir = mkTmp()
      const cassette = join(dir, "cassette.jsonl")
      const firstMarker = join(dir, "approval-one")
      const secondMarker = join(dir, "approval-two")
      writeFileSync(
        cassette,
        multipleApprovalCassette(
          `touch ${firstMarker}`,
          `touch ${secondMarker}`,
          "SERVE_MULTI_DONE",
        ),
      )
      const approvals: string[] = []
      const session = await connect({
        transport: transports.stdio({
          command: [BUN, CLI_ENTRY, "serve", "--stdio", "--cwd", dir],
          env: childEnv({ QUANTA_SERVE_STDIO: "1", QUANTA_LLM_REPLAY: cassette }),
          cwd: dir,
        }),
        onApproval: async (approval) => {
          approvals.push(approval.approvalId)
          return "approve"
        },
      })
      try {
        await session.input.append("run both gated steps")
        await session.turn.run()
        const end = await session.awaitTurnEnd()
        expect(end.type).toBe("turn.completed")
        if (end.type === "turn.completed") {
          expect(end.assistantText ?? "").toContain("SERVE_MULTI_DONE")
        }
        expect(approvals).toHaveLength(2)
        expect(new Set(approvals).size).toBe(2)
        expect(existsSync(firstMarker)).toBe(true)
        expect(existsSync(secondMarker)).toBe(true)
      } finally {
        await session.close()
      }
    },
    { timeout: 90_000 },
  )

  test(
    "GATE OFF: the child refuses (no server), and connect() fails FAST + TYPED with the child's last words — never a silent hang",
    async () => {
      const dir = mkTmp()
      // NO QUANTA_SERVE_STDIO in the env — the transport injects NOTHING.
      const attempt = connect({
        transport: transports.stdio({
          command: [BUN, CLI_ENTRY, "serve", "--stdio", "--cwd", dir],
          env: childEnv({}),
          cwd: dir,
        }),
      })
      expect(attempt).rejects.toThrow(SessionHandleClosedError)
      // Re-run to inspect the reason (the child mentions the gate on stderr,
      // surfaced through the transport's stderr tail).
      try {
        await attempt
      } catch (error) {
        expect(String((error as Error).message)).toContain("QUANTA_SERVE_STDIO")
      }
    },
    { timeout: 90_000 },
  )

  test(
    "GATE OFF exit posture: exit 64, stdout EMPTY (byte-identical protocol channel), guidance on stderr",
    async () => {
      const dir = mkTmp()
      const raw = spawnRawServe({ env: childEnv({}), cwd: dir })
      await raw.child.exited
      expect(raw.child.exitCode).toBe(64)
      expect(raw.lines).toEqual([])
      expect(await raw.stderrText()).toContain("QUANTA_SERVE_STDIO")
    },
    { timeout: 90_000 },
  )

  test(
    "stdin EOF ⇒ graceful shutdown, exit 0 (the JsonlSessionEventLog release path is the same session.close())",
    async () => {
      const dir = mkTmp()
      const cassette = join(dir, "cassette.jsonl")
      writeFileSync(cassette, textCassette("unused"))
      const raw = spawnRawServe({
        env: childEnv({ QUANTA_SERVE_STDIO: "1", QUANTA_LLM_REPLAY: cassette }),
        cwd: dir,
      })
      // Boot-complete signal: the discovery reject proves the server is live
      // (no sleep-guessing) — THEN close stdin.
      raw.send({ kind: "connect", sessionId: "ui-session" })
      await raw.waitFor((m) => (m.kind === "rejected" ? true : undefined))
      raw.child.stdin.end()
      await raw.child.exited
      expect(raw.child.exitCode).toBe(0)
    },
    { timeout: 90_000 },
  )

  test(
    "SIGTERM ⇒ graceful shutdown, exit 0 (not a signal death)",
    async () => {
      const dir = mkTmp()
      const cassette = join(dir, "cassette.jsonl")
      writeFileSync(cassette, textCassette("unused"))
      const raw = spawnRawServe({
        env: childEnv({ QUANTA_SERVE_STDIO: "1", QUANTA_LLM_REPLAY: cassette }),
        cwd: dir,
      })
      raw.send({ kind: "connect", sessionId: "ui-session" })
      await raw.waitFor((m) => (m.kind === "rejected" ? true : undefined))
      raw.child.kill("SIGTERM")
      await raw.child.exited
      expect(raw.child.exitCode).toBe(0)
      expect(raw.child.signalCode).toBeNull()
    },
    { timeout: 90_000 },
  )

  test(
    "STDOUT PURITY: a full turn INCLUDING a real bash child process leaves stdout 100% session.v1 frames (child stdio must not inherit the protocol channel)",
    async () => {
      const dir = mkTmp()
      const cassette = join(dir, "cassette.jsonl")
      // bypass mode: the bash tool runs WITHOUT an approval park — its child
      // writes to ITS stdout; none of that may reach the serve process's
      // stdout. This is the ticket-named risk scenario.
      writeFileSync(
        cassette,
        `${[
          JSON.stringify({
            id: "replay",
            events: [
              { type: "tool_use_start", id: "p1", name: "bash" },
              { type: "tool_use_end", id: "p1", input: { command: "echo CHILD-STDOUT-NOISE" } },
              { type: "message_stop", stop_reason: "tool_use" },
            ],
          }),
          JSON.stringify({
            id: "replay",
            events: [
              { type: "text_delta", delta: "PURITY_DONE" },
              { type: "message_stop", stop_reason: "end_turn" },
            ],
          }),
        ].join("\n")}\n`,
      )
      const raw = spawnRawServe({
        argv: ["serve", "--stdio", "--cwd", dir, "--permission-mode", "bypass"],
        env: childEnv({ QUANTA_SERVE_STDIO: "1", QUANTA_LLM_REPLAY: cassette }),
        cwd: dir,
      })
      const lines = await runRawTurn(raw)
      expect(lines.length).toBeGreaterThan(0)
      expect(impureStdoutLines(lines)).toEqual([])
      raw.child.stdin.end()
      await raw.child.exited
      expect(raw.child.exitCode).toBe(0)
    },
    { timeout: 90_000 },
  )

  test(
    "PURITY RATCHET TEETH (paired control): an injected stdout polluter IS flagged by the SAME checker — the ratchet is not vacuous",
    async () => {
      const dir = mkTmp()
      const cassette = join(dir, "cassette.jsonl")
      writeFileSync(cassette, textCassette("CONTROL_TEXT"))
      const raw = spawnRawServe({
        entry: POLLUTER_ENTRY,
        argv: ["serve", "--stdio", "--cwd", dir],
        env: childEnv({ QUANTA_SERVE_STDIO: "1", QUANTA_LLM_REPLAY: cassette }),
        cwd: dir,
      })
      const lines = await runRawTurn(raw)
      const impure = impureStdoutLines(lines)
      expect(impure.length).toBeGreaterThan(0)
      expect(impure.join("\n")).toContain("SERVE_STDIO_POLLUTION")
      raw.child.stdin.end()
      await raw.child.exited
    },
    { timeout: 90_000 },
  )
})
