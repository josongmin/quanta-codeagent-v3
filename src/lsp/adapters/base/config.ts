/** Options shared by every stdio LSP adapter. The two concrete adapters differ
 *  only in their default {@link LspClientSpec.defaultCommand} and
 *  {@link LspClientSpec.languageIdFor}; everything else (handshake, framing,
 *  request correlation, lifecycle) is identical and lives once in `LspClient`
 *  (RFC §3.1: 2+ implementations ⇒ extract a shared base). */
export interface LspClientOptions {
  /** Argv used to spawn the server. Defaults to the standard stdio launcher. */
  command?: string[]
  /** Project root the server analyses. Defaults to `process.cwd()`. */
  cwd?: string
  /** Per-request timeout (also bounds the diagnostics wait). Default 8000ms. */
  requestTimeoutMs?: number
  /** Optional workspace roots advertised during `initialize`. */
  workspaceFolders?: readonly string[]
  /** Client-side config surfaced via `workspace/configuration` requests. */
  workspaceConfiguration?: Readonly<Record<string, unknown>>
  /** Optional whole-tree process killer supplied by the composition root. */
  processTreeKiller?: LspProcessTreeKiller
}

export type LspProcessTreeSignal = "SIGTERM" | "SIGKILL"

export interface LspProcessTreeKiller {
  signalTree(rootPid: number, signal: LspProcessTreeSignal): void
}

/** Per-server identity supplied by the concrete adapter (its only variance). */
export interface LspClientSpec {
  /** Default argv when {@link LspClientOptions.command} is not given. */
  defaultCommand: string[]
  /** Resolve the LSP `languageId` for a file (e.g. `python`, `typescriptreact`). */
  languageIdFor(filePath: string): string
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000

/** Cap on the retained stderr tail (bytes of decoded text). The drain pump must
 *  still consume the whole stream to keep the OS pipe empty (deadlock guard);
 *  this only bounds how much of the MOST RECENT stderr we keep so an unexpected
 *  server exit (crash / OOM) can be diagnosed. Flat literal so the magic-number
 *  scan does not trip. */
export const STDERR_TAIL_MAX = 8_192
