/**
 * `@/ipc/transports/uds` — Unix Domain Socket transport (skeleton + framing).
 *
 * The on-disk path convention is `~/.quanta/ipc.sock`. Wire framing is the
 * same line-delimited JSON used by `stdio` so a daemon can multiplex stdio
 * (subprocess) and uds (local IPC) peers behind one envelope reader.
 *
 * Status: **partial**. The reader/writer ports are abstracted (same shape
 * as `stdio.ts`) and the framing is reused, but the actual `node:net`
 * connect / listen / accept dance lives in a follow-up PR. The default-OFF
 * contract means no surface constructs a uds transport today, so the
 * skeleton here is just the contract + path resolver + a thin
 * `connectUdsTransport` adapter that delegates framing to the stdio path
 * once a duplex socket is handed in.
 *
 * Why this slice ships the path resolver: the daemon and the CLI client
 * MUST agree on the socket location WITHOUT importing each other's
 * surface helpers. `udsSocketPath()` is the canonical answer.
 */

import type { BridgeTransport } from "../event-bridge"
import { createStdioTransport, type StdioReader, type StdioWriter } from "./stdio"

/**
 * Default IPC socket path under the user's home directory. Surfaces
 * resolve `~` themselves (the IPC slice does not read env); this helper
 * just renders the conventional suffix.
 *
 * Convention: `<home>/.quanta/ipc.sock`. A future multi-daemon design can
 * suffix the path with a session id (`ipc-<id>.sock`) without breaking
 * existing callers — the resolver is opaque to consumers.
 */
export const udsSocketSuffix = (): string => ".quanta/ipc.sock"

/**
 * Render the absolute socket path given an explicit `home`. Splitting the
 * `home` argument from the suffix keeps the slice surface-agnostic — the
 * surface entry resolves `os.homedir()` / `process.env.HOME` and passes
 * the result in.
 */
export const udsSocketPath = (home: string): string => {
  const trimmed = home.replace(/\/+$/, "")
  return `${trimmed}/${udsSocketSuffix()}`
}

/**
 * Adapter: given a connected Duplex (a `net.Socket` from `node:net` once
 * the surface entry creates one), wrap it as a `BridgeTransport`. Framing
 * is line-delimited JSON, identical to stdio — so the underlying envelope
 * encoder is reused verbatim.
 *
 * The argument is structurally typed (StdioReader + StdioWriter) so this
 * file does NOT import `node:net`; the surface entry constructs the
 * socket and passes it in. This keeps `@/ipc` reachable from
 * non-Node runtimes (Web/Tauri test harnesses).
 */
export const wrapDuplexAsUdsTransport = (duplex: StdioReader & StdioWriter): BridgeTransport => {
  return createStdioTransport({ reader: duplex, writer: duplex })
}
