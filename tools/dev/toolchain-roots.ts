/**
 * `tools/dev/toolchain-roots` — the toolchain install roots a replaced HOME would hide.
 *
 * # The defect
 *
 * The test preload moves HOME to scratch so no test writes Quanta state into the
 * developer's home (`tests/_support/quanta-home-fence.ts`). rustup and cargo find
 * their toolchains through HOME: `RUSTUP_HOME` and `CARGO_HOME` default to
 * `~/.rustup` and `~/.cargo`. MEASURED after the fence landed: every Rust arm of
 * `test:real-toolchain` failed with `rustup could not choose a version of cargo to
 * run`, seven of them, while the binaries sat on PATH.
 *
 * These are TOOLCHAIN roots, not Quanta state, so they are pinned to where they
 * really are whenever HOME is replaced and they are unset. A root is kept only if
 * it exists, so a host without Rust gets nothing new. Cargo may then write its
 * registry cache under the real `~/.cargo`, which is where it wrote before the
 * fence.
 *
 * Python's user site (`~/Library/Python/X.Y` on macOS) is NOT here: its location
 * depends on the interpreter's version, and one `PYTHONUSERBASE` would point every
 * other interpreter at the wrong directory. Receipts say when a Python package is
 * hidden this way (`AVAILABLE under the real HOME`).
 *
 * Every place that replaces HOME uses this one function — the fence, the shard
 * runner's workers and probes, the lane wrapper's child and probes — so a probe
 * and the test it answers for see the same roots.
 */

import { join } from "node:path"

export const TOOLCHAIN_HOME_ROOTS: readonly (readonly [key: string, leaf: string])[] = [
  ["RUSTUP_HOME", ".rustup"],
  ["CARGO_HOME", ".cargo"],
]

export const keptToolchainRoots = (input: {
  readonly env: Readonly<Record<string, string | undefined>>
  /** The HOME being replaced; `undefined` when nothing real is being replaced. */
  readonly realHome: string | undefined
  readonly exists: (path: string) => boolean
}): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  const home = input.realHome?.trim()
  if (home === undefined || home === "") return out
  for (const [key, leaf] of TOOLCHAIN_HOME_ROOTS) {
    const current = input.env[key]
    if (current !== undefined && current.trim() !== "") continue
    const root = join(home, leaf)
    if (input.exists(root)) out[key] = root
  }
  return out
}
