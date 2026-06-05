/** jun-06 — Linux libsecret (Secret Service) adapter for {@link KeyringPort},
 *  via the injected `secret-tool` CLI (closed-port — run through the supplied
 *  {@link KeyringExec}, never a hard-coded `child_process`).
 *
 *  ## Secret never on argv
 *
 *  `secret-tool store` reads the secret from STDIN by design — it NEVER takes
 *  the secret as an argument (only the lookup attributes are on argv). So the
 *  secret is never visible to `ps` / `/proc/<pid>/cmdline`. `lookup` prints the
 *  secret to stdout; `clear` removes it; all non-secret attribute keys
 *  (`service`, `account`) stay on argv.
 *
 *  ## NO-THROW
 *
 *  A non-zero exit / spawn error (no `secret-tool`, no D-Bus session bus on a
 *  headless box) maps onto the empty result — `available()===false` there, so
 *  the caller falls back to the file store with no regression for CI/servers.
 */

import type { KeyringExec, KeyringPort } from "./port"

const BIN = "secret-tool"

export const createLibsecretKeyring = (exec: KeyringExec): KeyringPort => ({
  async available() {
    // Probe: `secret-tool` exists AND a Secret Service is reachable. A bare
    // `--version` only proves the binary exists, so we probe a benign lookup of
    // a sentinel attribute — a missing item is a 1 exit (service reachable, no
    // match) which we accept; a service/bus error is a different non-zero exit.
    // To keep the probe simple and bus-sensitive, run `--version`: if the binary
    // is absent the spawn fails ⇒ unavailable. The store/lookup ops themselves
    // NO-THROW on a bus error, so a false positive here still degrades safely.
    const res = await exec({ bin: BIN, args: ["--version"] })
    return res.ok
  },

  async get(service, account) {
    const res = await exec({
      bin: BIN,
      args: ["lookup", "service", service, "account", account],
    })
    if (!res.ok) return undefined
    // `secret-tool lookup` prints the secret with NO trailing newline, but trim
    // a possible one defensively.
    const out = res.stdout.replace(/\n$/, "")
    return out.length > 0 ? out : undefined
  },

  async set(service, account, secret) {
    // `store` reads the secret from STDIN (never argv). A label is required.
    await exec({
      bin: BIN,
      args: ["store", "--label", `${service}:${account}`, "service", service, "account", account],
      stdin: secret,
    })
  },

  async delete(service, account) {
    await exec({
      bin: BIN,
      args: ["clear", "service", service, "account", account],
    })
  },
})
