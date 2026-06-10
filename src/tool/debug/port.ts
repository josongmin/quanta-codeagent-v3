/**
 * W5 DAP — the spawn seam. A {@link DebugAdapterPort} turns an adapter argv
 * into a live {@link DapTransport} (the byte carrier the client speaks over).
 * Tools depend on the PORT, never on `Bun.spawn`, so they test against a
 * scripted in-memory adapter (closed-port DI, same posture as the PTY slice).
 */
import { type AddressInfo, createServer, Socket } from "node:net"
import type { DapTransport } from "./dap-client"

export interface AdapterSpawnSpec {
  /** Adapter argv, e.g. `["python", "-m", "debugpy.adapter"]`. */
  readonly command: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
}

export interface DebugAdapterPort {
  /** Spawn the adapter and return a transport over its stdio. Rejects if the
   *  adapter cannot be launched (the tool maps that to an ok:false result). */
  spawn(spec: AdapterSpawnSpec): Promise<DapTransport>
}

/** Concrete port: spawns the adapter via `Bun.spawn` and bridges its stdio.
 *  Inbound stdout bytes are pumped to the registered `onData` sink; outbound
 *  framed bytes are written to the child's stdin. `close()` kills the child. */
export const defaultDebugAdapterPort: DebugAdapterPort = {
  async spawn(spec: AdapterSpawnSpec): Promise<DapTransport> {
    const [cmd, ...args] = spec.command
    if (cmd === undefined) throw new Error("debug adapter: empty command")
    const child = Bun.spawn([cmd, ...args], {
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env: spec.env !== undefined ? { ...process.env, ...spec.env } : process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    let sink: ((chunk: string | Buffer) => void) | undefined
    // Pump stdout → sink. The reader runs detached; a closed stream ends it.
    void (async () => {
      try {
        const reader = child.stdout.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value !== undefined && sink !== undefined) sink(Buffer.from(value))
        }
      } catch {
        // stream torn down — the client's pending requests resolve via dispose().
      }
    })()
    // Bun's piped stdin is a FileSink (`.write`/`.flush`), not a WritableStream.
    const stdin = child.stdin as { write(d: Uint8Array): number; flush(): void }
    return {
      send: (data) => {
        stdin.write(new TextEncoder().encode(data))
        stdin.flush()
      },
      onData: (cb) => {
        sink = cb
      },
      close: () => {
        try {
          child.kill()
        } catch {
          // best-effort
        }
      },
    }
  },
}

// ── TCP transport (dlv-dap / vscode-js-debug speak DAP over a socket) ────────

/** Pick a free localhost TCP port (bind :0, read the assigned port, release). */
export const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })

export interface TcpConnectSpec {
  readonly host: string
  readonly port: number
  /** Total budget to keep retrying the connect (the adapter needs a moment to
   *  start listening after spawn). Default 5s. */
  readonly connectTimeoutMs?: number
}

/** A {@link DapTransport} over a connected TCP socket — byte-identical contract
 *  to the stdio transport, so DapClient/inspectViaDap are carrier-agnostic. */
const transportFromSocket = (socket: Socket, onClose?: () => void): DapTransport => ({
  send: (data) => {
    socket.write(data)
  },
  onData: (cb) => {
    socket.on("data", (buf: Buffer) => cb(buf))
  },
  close: () => {
    try {
      socket.destroy()
    } catch {
      // already closed
    }
    onClose?.()
  },
})

/** Connect to a TCP DAP adapter, RETRYING until it is listening or the budget
 *  elapses (a freshly-spawned adapter isn't accepting connections instantly).
 *  Rejects (never hangs) when the budget runs out. */
export const connectTcpTransport = async (spec: TcpConnectSpec, onClose?: () => void): Promise<DapTransport> => {
  const deadline = Date.now() + (spec.connectTimeoutMs ?? 5_000)
  for (;;) {
    try {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const s = new Socket()
        const onErr = (e: Error) => {
          s.destroy()
          reject(e)
        }
        s.once("error", onErr)
        s.connect(spec.port, spec.host, () => {
          s.removeListener("error", onErr)
          resolve(s)
        })
      })
      return transportFromSocket(socket, onClose)
    } catch (e) {
      if (Date.now() >= deadline) throw new Error(`dap: TCP connect to ${spec.host}:${spec.port} failed: ${(e as Error).message}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

export interface TcpAdapterSpawnSpec {
  /** Build the adapter argv given the chosen port (e.g. dlv: `["dlv","dap","--listen",`127.0.0.1:${p}`]`). */
  readonly command: (port: number) => readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly host?: string
  readonly connectTimeoutMs?: number
}

/** Spawn a TCP debug adapter (told to listen on a chosen free port), connect,
 *  and return a transport whose `close()` ALSO kills the spawned adapter. */
export const spawnTcpDebugAdapter = async (spec: TcpAdapterSpawnSpec): Promise<DapTransport> => {
  const host = spec.host ?? "127.0.0.1"
  const port = await getFreePort()
  const [cmd, ...args] = spec.command(port)
  if (cmd === undefined) throw new Error("debug adapter: empty TCP command")
  const child = Bun.spawn([cmd, ...args], {
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    env: spec.env !== undefined ? { ...process.env, ...spec.env } : process.env,
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    return await connectTcpTransport({ host, port, ...(spec.connectTimeoutMs !== undefined ? { connectTimeoutMs: spec.connectTimeoutMs } : {}) }, () => {
      try {
        child.kill()
      } catch {
        // best-effort
      }
    })
  } catch (e) {
    try {
      child.kill()
    } catch {
      // best-effort
    }
    throw e
  }
}
