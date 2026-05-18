import type { Diagnostic } from "./types"

/** Provider-agnostic contract for a language-server client.
 *
 *  Lifecycle: {@link start} brings the server up and completes the LSP
 *  handshake; {@link diagnostics} opens a document and returns the diagnostics
 *  the server publishes for it; {@link stop} shuts the server down cleanly and
 *  releases every resource (process, timers, listeners). Implementations must
 *  be safe to {@link stop} even if {@link start} failed or never ran. */
export interface LspPort {
  start(): Promise<void>
  diagnostics(filePath: string): Promise<Diagnostic[]>
  stop(): Promise<void>
}
