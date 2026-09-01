import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildProductionRuntimeFactory } from "@/apps/web-daemon/runtime-factory"
import { startWebDaemon } from "@/apps/web-daemon/server"
import type { WebDaemonHandle } from "@/apps/web-daemon/types"
import type { SessionTransportMessage } from "@/ipc/session"
import { decodeSessionTransportMessage, encodeSessionTransportMessage } from "@/ipc/session"
import type { LLMPort } from "@/llm"
import type { CostSurfaceViewWire, SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { supported } from "@/protocol/session"
import type { RuntimeFacade } from "@/sdk/runtime"
import { loadSessionById, type SavedSession, staticSessionRootProvider } from "@/session"
import { __resetRuntimeConfig } from "@/shared"

export const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out: ${label}`)
}

/** Feed the actual received snapshot through the frontend reducer and header. */
export const renderSnapshotHeader = async (snapshot: SessionSnapshotLite): Promise<string> => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `import { createElement } from "react";
       import { renderToStaticMarkup } from "react-dom/server";
       import { TokenCounter } from "./src/components/TokenCounter.tsx";
       import { initialTranscript, transcriptReducer } from "./src/ws/session-hooks.ts";
       const snapshot = await Bun.stdin.json();
       const state = transcriptReducer(initialTranscript, {
         type: "snapshot", snapshot, receivedAt: "2026-08-30T00:00:00Z"
       });
       console.log(renderToStaticMarkup(createElement(TokenCounter, {
         usage: state.tokenUsage, costView: state.costView
       })));`,
    ],
    cwd: join(import.meta.dir, "../../apps/web-frontend"),
    stdin: new Blob([JSON.stringify(snapshot)]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`Frontend header renderer exited ${exit}: ${errors}`)
  return output.trim()
}

/** Test-owned environment and sockets; only the boot LLM is replaced. */
export const bootUsageDaemon = async (
  llm: LLMPort,
  mode: "on" | "off" = "on",
  observeRuntime?: (runtime: RuntimeFacade) => void,
) => {
  const root = mkdtempSync(join(tmpdir(), "quanta-web-usage-live-"))
  const priorCwd = process.cwd()
  const priorEnv = { ...process.env }
  const priorFetch = globalThis.fetch
  const sockets: WebSocket[] = []
  let handle: WebDaemonHandle | undefined
  let externalNetworkAttempts = 0
  const sessions = join(root, "sessions")
  const sessionRoot = staticSessionRootProvider(sessions)
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("QUANTA_") || key.startsWith("CLAUDE_CODE_USE_")) delete process.env[key]
  }
  Object.assign(process.env, {
    QUANTA_CONFIG_DIR: join(root, "config"),
    QUANTA_SESSIONS_DIR: sessions,
    QUANTA_WEB_DB_DIR: join(root, "web-db"),
    QUANTA_SKILLS_DIR: join(root, "skills"),
    QUANTA_USAGE_ACCOUNTING_V2: mode,
    QUANTA_GOAL: "0",
    QUANTA_MEMORY: "off",
    QUANTA_MEMORY_AUTO: "0",
    QUANTA_SKILLS: "0",
    QUANTA_SUBAGENT: "1",
    QUANTA_OBSERVABILITY: "0",
    QUANTA_PROVIDER: "anthropic",
    QUANTA_MODEL: llm.model,
  })
  process.chdir(root)
  __resetRuntimeConfig()
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (handle !== undefined && url.origin === `http://127.0.0.1:${handle.port}`) {
      return priorFetch(input, init)
    }
    externalNetworkAttempts += 1
    throw new Error(`External network forbidden in usage E2E: ${url.origin}`)
  }) as typeof fetch

  const cleanup = async () => {
    for (const socket of sockets) socket.close()
    try {
      await handle?.stop()
    } finally {
      globalThis.fetch = priorFetch
      process.chdir(priorCwd)
      for (const key of Object.keys(process.env)) {
        if (!(key in priorEnv)) delete process.env[key]
      }
      Object.assign(process.env, priorEnv)
      __resetRuntimeConfig()
      rmSync(root, { recursive: true, force: true })
    }
  }

  try {
    handle = await startWebDaemon({
      port: 0,
      bind: "127.0.0.1",
      authToken: "usage-e2e",
      runtimeFactory: async () => {
        const runtime = await buildProductionRuntimeFactory({
          boot: { provider: "anthropic", model: llm.model ?? "claude-sonnet-4-6", llm },
        })()
        observeRuntime?.(runtime)
        return runtime
      },
      sessionConfig: { cwd: root, permissionMode: "acceptEdits" },
      supportedReadModels: {
        session: supported("session.v1"),
        agentState: { status: "unsupported" },
        canvas: { status: "unsupported" },
        observability: { status: "unsupported" },
      },
    })
  } catch (error) {
    await cleanup()
    throw error
  }

  const port = handle.port
  return {
    root,
    sessions,
    sessionRoot,
    cleanup,
    externalNetworkAttempts: () => externalNetworkAttempts,
    cost: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/readout/cost`, {
        headers: { authorization: "Bearer usage-e2e" },
      })
      if (response.status !== 200) throw new Error(`Cost HTTP status ${response.status}`)
      return response.json() as Promise<{ wired: boolean; isError: boolean; output: string }>
    },
    saved: (id: string) => loadSessionById(id, sessionRoot),
    waitSaved: async (
      id: string,
      calls: number,
      supersededUsageAccounting?: string,
    ): Promise<SavedSession> => {
      let saved: SavedSession | undefined
      await until(async () => {
        saved = await loadSessionById(id, sessionRoot)
        if (saved?.usageAccounting === undefined) return false
        if (saved.usageAccounting === supersededUsageAccounting) return false
        return (
          (JSON.parse(saved.usageAccounting) as { total: { calls: number } }).total.calls === calls
        )
      }, `persist ${id} calls=${calls}`)
      if (saved === undefined) throw new Error("saved session vanished")
      return saved
    },
    connect: async (threadId?: string, resumeFromSeq?: number) => {
      const query = new URLSearchParams({ token: "usage-e2e" })
      if (threadId !== undefined) query.set("thread", threadId)
      const socket = new WebSocket(`ws://127.0.0.1:${port}/?${query}`)
      sockets.push(socket)
      const frames: SessionTransportMessage[] = []
      socket.addEventListener("message", (event) => {
        frames.push(decodeSessionTransportMessage(String(event.data)))
      })
      await until(() => socket.readyState === WebSocket.OPEN, "socket open")
      socket.send(encodeSessionTransportMessage({ kind: "connect", sessionId: "" }))
      await until(() => frames.some((frame) => frame.kind === "rejected"), "session discovery")
      const discovery = frames.find((frame) => frame.kind === "rejected")
      if (discovery?.kind !== "rejected") throw new Error("missing discovery frame")
      const sessionId = discovery.sessionId
      socket.send(
        encodeSessionTransportMessage({
          kind: "connect",
          sessionId,
          ...(resumeFromSeq !== undefined ? { resumeFromSeq, resumeAck: true as const } : {}),
        }),
      )
      await until(() => frames.some((frame) => frame.kind === "snapshot"), "connect snapshot")
      if (resumeFromSeq !== undefined) {
        await until(
          () => frames.some((frame) => frame.kind === "resumed"),
          "resume acknowledgement",
        )
      }
      const events = (): SessionEvent[] =>
        frames.flatMap((frame) => (frame.kind === "event" ? [frame.event] : []))
      const clientId = crypto.randomUUID()
      socket.send(
        encodeSessionTransportMessage({
          kind: "command",
          command: {
            sessionId,
            issuedAt: new Date().toISOString(),
            commandId: `permission-${clientId}`,
            type: "session.permission.set",
            mode: "bypass",
          },
        }),
      )
      let sequence = 0
      return {
        sessionId,
        socket,
        frames,
        events,
        snapshot: (): SessionSnapshotLite => {
          const latest = frames.filter((frame) => frame.kind === "snapshot").at(-1)
          if (latest?.kind !== "snapshot") throw new Error("production connect omitted snapshot")
          return latest.snapshot
        },
        run: async (text: string): Promise<CostSurfaceViewWire> => {
          const count = events().filter((event) => event.type === "turn.completed").length
          sequence += 1
          const command = { sessionId, issuedAt: new Date().toISOString() }
          socket.send(
            encodeSessionTransportMessage({
              kind: "command",
              command: {
                ...command,
                type: "input.append",
                text,
                commandId: `append-${clientId}-${sequence}`,
              },
            }),
          )
          socket.send(
            encodeSessionTransportMessage({
              kind: "command",
              command: {
                ...command,
                type: "turn.run",
                commandId: `run-${clientId}-${sequence}`,
              },
            }),
          )
          await until(
            () => events().filter((event) => event.type === "turn.completed").length > count,
            `turn ${sequence} completion; frames=${JSON.stringify(frames)}`,
          )
          const completed = events()
            .filter((event) => event.type === "turn.completed")
            .at(-1)
          if (completed?.type !== "turn.completed" || completed.costView === undefined) {
            throw new Error("production turn omitted costView")
          }
          return completed.costView
        },
      }
    },
  }
}
