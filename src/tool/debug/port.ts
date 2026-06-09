/**
 * W5 DAP — the spawn seam. A {@link DebugAdapterPort} turns an adapter argv
 * into a live {@link DapTransport} (the byte carrier the client speaks over).
 * Tools depend on the PORT, never on `Bun.spawn`, so they test against a
 * scripted in-memory adapter (closed-port DI, same posture as the PTY slice).
 */
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
