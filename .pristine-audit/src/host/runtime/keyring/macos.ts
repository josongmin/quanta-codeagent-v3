/** jun-06 — macOS Keychain adapter for {@link KeyringPort}, via the injected
 *  `security` CLI (closed-port — the binary is run through the supplied
 *  {@link KeyringExec}, never a hard-coded `child_process`).
 *
 *  ## Secret never on argv
 *
 *  `security add-generic-password` accepts the password EITHER as `-w <pw>`
 *  (argv-visible to `ps` / `/proc`) OR as `-w` with NO value, in which case it
 *  reads the password from the input stream (prompt). We ALWAYS use the
 *  no-value `-w` form and feed the secret on STDIN — so the secret is never a
 *  positional/flag argument and never appears in the process command line.
 *  The account/service NAMESPACE keys (`-s`, `-a`) are non-secret and stay on
 *  argv.
 *
 *  ## Failure contract
 *
 *  `get`/`available`/`delete` map a non-zero exit / spawn error onto the empty
 *  result (`undefined` / `false` / void) — a locked/denied keychain degrades to
 *  "secret absent", never throwing into the MCP load. `set` is the exception: a
 *  non-zero exit (write did NOT persist) THROWS a SECRET-FREE error so
 *  `composeTokenStore` falls back to the 0600 file store rather than silently
 *  dropping the token.
 */

import type { KeyringExec, KeyringPort } from "./port"

const BIN = "security"

export const createMacosKeyring = (exec: KeyringExec): KeyringPort => ({
  async available() {
    // Probe: `security` exists and the default keychain is reachable. A
    // non-zero exit / missing binary ⇒ unavailable (fall back to file store).
    const res = await exec({ bin: BIN, args: ["default-keychain"] })
    return res.ok
  },

  async get(service, account) {
    // `-w` prints ONLY the password to stdout; a missing item exits non-zero.
    const res = await exec({
      bin: BIN,
      args: ["find-generic-password", "-s", service, "-a", account, "-w"],
    })
    if (!res.ok) return undefined
    // `security` appends a trailing newline to the printed password.
    const out = res.stdout.replace(/\n$/, "")
    return out.length > 0 ? out : undefined
  },

  async set(service, account, secret) {
    // `-U` updates in place if the item exists. `-w` with NO value ⇒ read the
    // password from STDIN (the secret NEVER appears on argv).
    const res = await exec({
      bin: BIN,
      args: ["add-generic-password", "-U", "-s", service, "-a", account, "-w"],
      stdin: secret,
    })
    // A locked/denied keychain exits NON-ZERO. If we swallowed that, the caller
    // (composeTokenStore.write) would treat the write as success and never fall
    // back to the 0600 file store — the token would be SILENTLY DROPPED. Throw a
    // SECRET-FREE error so the file fallback engages. (set is the ONE op that
    // signals failure by throwing; get/delete/available stay empty-on-failure.)
    if (!res.ok) throw new Error("keyring: macOS Keychain write failed (non-zero exit)")
  },

  async delete(service, account) {
    // Idempotent — a missing item exits non-zero, which we ignore (NO-THROW).
    await exec({
      bin: BIN,
      args: ["delete-generic-password", "-s", service, "-a", account],
    })
  },
})
