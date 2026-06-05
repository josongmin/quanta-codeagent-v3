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
 *  ## NO-THROW
 *
 *  Every method maps a non-zero exit / spawn error onto the empty result
 *  (`undefined` / `false` / void). A locked/denied keychain therefore degrades
 *  to "secret absent", never throws into the MCP load.
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
    await exec({
      bin: BIN,
      args: ["add-generic-password", "-U", "-s", service, "-a", account, "-w"],
      stdin: secret,
    })
  },

  async delete(service, account) {
    // Idempotent — a missing item exits non-zero, which we ignore (NO-THROW).
    await exec({
      bin: BIN,
      args: ["delete-generic-password", "-s", service, "-a", account],
    })
  },
})
