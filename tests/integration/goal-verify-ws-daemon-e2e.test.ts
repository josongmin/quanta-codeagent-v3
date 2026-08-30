import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startWebDaemon } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import { buildInteractiveTurnAssembler } from "@/host/runtime"
import {
  createObjectiveCheckRunner,
  createObjectiveVerificationCoordinator,
  createWorkspaceEvidence,
} from "@/host/runtime/objective-verifier-wire"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { createObjectiveAuthority, createObjectiveCapabilities } from "@/objective"
import type { PermissionContext } from "@/permission"
import { SESSION_PROTOCOL_VERSION, supported } from "@/protocol/session"
import { createRuntimeFromAgentConfigBase, type RuntimeSession } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class IdleLLM implements LLMPort {
  readonly model = "idle"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

const git = (cwd: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const until = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(10)
  }
  return predicate()
}

describe("real daemon /goal verify", () => {
  let dir: string
  let handle: WebDaemonHandle | undefined
  let socket: WebSocket | undefined
  let oldDb: string | undefined

  beforeEach(() => {
    oldDb = process.env.QUANTA_WEB_DB
    process.env.QUANTA_WEB_DB = "off"
    dir = mkdtempSync(join(tmpdir(), "goal-verify-ws-"))
    git(dir, "init", "-q")
    writeFileSync(join(dir, "tracked.txt"), "v1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
  })

  afterEach(async () => {
    socket?.close()
    if (handle !== undefined) await handle.stop()
    rmSync(dir, { recursive: true, force: true })
    if (oldDb === undefined) delete process.env.QUANTA_WEB_DB
    else process.env.QUANTA_WEB_DB = oldDb
  })

  test("real command receipt is committed through the correlated socket result", async () => {
    const authority = createObjectiveAuthority({ now: () => Date.now() })
    const caps = createObjectiveCapabilities(authority)
    const verifier = createObjectiveVerificationCoordinator({
      read: caps.read,
      verifier: caps.verifier,
      runner: createObjectiveCheckRunner(),
      evidence: createWorkspaceEvidence(),
      workspaceCwd: dir,
    })
    const { runtimeContext } = await createRuntimeFromAgentConfigBase({
      base: {
        llm: new IdleLLM(),
        registry: new ToolRegistry([]),
        stream: new NullStream(),
        permission: { mode: "acceptEdits" } as PermissionContext,
        messages: [],
        system: "test",
        cwd: dir,
        maxTurns: 2,
        signal: new AbortController().signal,
        objective: authority,
        objectiveVerifier: verifier,
      },
      turnAssembler: buildInteractiveTurnAssembler({}, {}),
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const runtime = await runtimeContext.createRuntimeFacade({
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
      mcpClients: [],
    })
    let session: RuntimeSession | undefined
    handle = await startWebDaemon({
      port: 0,
      bind: "127.0.0.1",
      authToken: undefined,
      runtimeFactory: async () =>
        ({
          ...runtime,
          objectiveAuthority: authority,
          objectiveVerifier: verifier,
          createSession: async (config: Parameters<typeof runtime.createSession>[0]) => {
            session = await runtime.createSession(config)
            return session
          },
        }) as never,
      sessionConfig: { cwd: dir, permissionMode: "acceptEdits" } as never,
      supportedReadModels: {
        session: supported("session.v1"),
        agentState: { status: "unsupported" },
        canvas: { status: "unsupported" },
        observability: { status: "unsupported" },
      },
    })
    if (session === undefined) throw new Error("session missing")
    authority.create(session.sessionId, {
      goal: "ship",
      criteria: [
        {
          text: "command passes",
          check: {
            kind: "command",
            argv: ["bun", "-e", "process.exit(0)"],
            timeoutMs: 5_000,
            successExitCodes: [0],
          },
        },
      ],
    })

    const frames: Record<string, unknown>[] = []
    socket = new WebSocket(`ws://${handle.hostname}:${handle.port}/`)
    socket.addEventListener("message", (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>)
    })
    await new Promise<void>((resolve, reject) => {
      socket?.addEventListener("open", () => resolve(), { once: true })
      socket?.addEventListener("error", () => reject(new Error("ws error")), { once: true })
    })
    socket.send(
      JSON.stringify({
        version: SESSION_PROTOCOL_VERSION,
        kind: "connect",
        sessionId: session.sessionId,
      }),
    )
    expect(await until(() => frames.some((frame) => frame.kind === "snapshot"))).toBe(true)

    const revision = authority.readDomain(session.sessionId).revision
    socket.send(
      JSON.stringify({
        kind: "goalVerify",
        requestId: "verify-real-1",
        expectedObjectiveRevision: revision,
      }),
    )
    expect(
      await until(() =>
        frames.some(
          (frame) => frame.kind === "goalVerifyResult" && frame.requestId === "verify-real-1",
        ),
      ),
    ).toBe(true)
    const result = frames.find((frame) => frame.kind === "goalVerifyResult")
    expect(result).toMatchObject({
      requestId: "verify-real-1",
      status: "completed",
      outcome: { kind: "verified", passed: 1, failed: 0 },
    })
    const objective = authority.get(session.sessionId)
    expect(objective?.status).toBe("completed")
    expect(objective?.successCriteria[0]?.met).toBe(true)
    expect(objective?.successCriteria[0]?.completion?.source).toBe("verifier")
  }, 30_000)
})
