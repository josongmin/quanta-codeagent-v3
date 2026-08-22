/** jun-06 — platform → `KeyringPort` selection + the real `Bun.spawn`-backed
 *  exec the composition root injects.
 *
 *  `selectKeyring` takes an INJECTED `platform` (never `process.platform`) so it
 *  stays pure/testable; the root passes the real value. An unsupported platform
 *  ⇒ the null keyring (always unavailable ⇒ file fallback).
 */

import { createLibsecretKeyring } from "./libsecret"
import { createMacosKeyring } from "./macos"
import { createNullKeyring } from "./null"
import type { KeyringExec, KeyringPlatform, KeyringPort } from "./port"

export const selectKeyring = (platform: KeyringPlatform, exec: KeyringExec): KeyringPort => {
  if (platform === "darwin") return createMacosKeyring(exec)
  if (platform === "linux") return createLibsecretKeyring(exec)
  return createNullKeyring()
}

/** The production keyring exec: argv-array `Bun.spawn` (no shell). The secret
 *  (when present) is fed on STDIN — it is NEVER placed in `args`. A spawn error
 *  (binary missing) maps onto `{ ok: false, stdout: "" }` (NO-THROW). */
export const bunKeyringExec = (): KeyringExec => async (input) => {
  try {
    const proc = Bun.spawn([input.bin, ...input.args], {
      stdin: input.stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    if (input.stdin !== undefined && proc.stdin !== undefined) {
      proc.stdin.write(input.stdin)
      await proc.stdin.end()
    }
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    return { ok: exitCode === 0, stdout }
  } catch {
    return { ok: false, stdout: "" }
  }
}
