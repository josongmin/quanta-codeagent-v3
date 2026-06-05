/** jun-06 — `KeyringPort`: the closed-port OS-secret-store seam that backs the
 *  H18 MCP OAuth `TokenStorePort` when `QUANTA_MCP_OAUTH_KEYRING=1`.
 *
 *  ## Why a port (not a hard-coded `child_process.exec("security …")`)
 *
 *  The keyring is reached through an INJECTED platform seam — the OS CLI is run
 *  via a supplied {@link KeyringExec}, never a hard-coded binary path, and the
 *  platform is supplied (never `process.platform`). Tests inject a fake exec; no
 *  real keychain, no `process.env`, no `Date.now`/`Math.random` in the adapter.
 *
 *  ## NO-THROW
 *
 *  Every method is TOTAL: a locked keychain, a denied prompt, a missing session
 *  bus, or a spawn error (binary absent) resolves to `false`/`undefined`/void —
 *  it NEVER throws. `composeTokenStore` (see `./compose`) treats a thrown or
 *  empty result as "secret absent" and falls back to the 0600 file store, so a
 *  keyring outage degrades to "log in again", never a crashed MCP load.
 */

export interface KeyringPort {
  /** Available IFF the OS secret service is reachable in THIS session (e.g. a
   *  Linux box with no D-Bus session keyring ⇒ `false` ⇒ caller falls back to
   *  the file store). NO-THROW — a probe error resolves `false`. */
  available(): Promise<boolean>
  /** Read the secret for `(service, account)`, or `undefined` when absent /
   *  unreadable. NO-THROW. */
  get(service: string, account: string): Promise<string | undefined>
  /** Store (overwrite) the secret for `(service, account)`. The secret is passed
   *  to the OS CLI over STDIN / a secure prompt — NEVER on argv. NO-THROW. */
  set(service: string, account: string, secret: string): Promise<void>
  /** Remove the secret for `(service, account)`. Idempotent (absent is fine).
   *  NO-THROW. */
  delete(service: string, account: string): Promise<void>
}

/** Outcome of one injected keyring-CLI invocation. `ok` is true on a 0 exit;
 *  `stdout` carries the looked-up secret on a read. A spawn error (binary
 *  missing) MUST resolve `{ ok: false, stdout: "" }`, never throw. */
export interface KeyringExecResult {
  readonly ok: boolean
  readonly stdout: string
}

/** The injected platform seam. The adapter NEVER constructs argv that contains
 *  the secret — when a value must be written, it is handed to the exec via
 *  {@link KeyringExecInput.stdin} (read by `security -w`-prompt / `secret-tool
 *  store`), so the secret is never visible to `ps`/`/proc/<pid>/cmdline`. */
export type KeyringExec = (input: KeyringExecInput) => Promise<KeyringExecResult>

export interface KeyringExecInput {
  /** Absolute or PATH-resolved binary name (e.g. `"security"`, `"secret-tool"`).
   *  Supplied by the adapter, NOT a caller — kept off the secret path. */
  readonly bin: string
  /** Argv AFTER the binary. The secret is NEVER placed here. */
  readonly args: readonly string[]
  /** Secret payload to feed on STDIN (the only channel a secret travels). */
  readonly stdin?: string
}

/** Supported keyring backends, selected by the injected `platform` string at the
 *  composition root (mirrors `NodeJS.Platform` values for `"darwin"`/`"linux"`).
 *  Anything else falls to the null keyring. */
export type KeyringPlatform = string
