/**
 * `tools/dev/toolchain-roots` — lend the toolchain roots a replaced HOME would hide.
 *
 * # The defect
 *
 * The test preload moves HOME to scratch so no test writes Quanta state into the
 * developer's home (`tests/_support/quanta-home-fence.ts`). rustup and cargo find
 * their toolchains through HOME (`~/.rustup`, `~/.cargo`). MEASURED after the fence
 * landed: every Rust arm of `test:real-toolchain` failed with `rustup could not
 * choose a version of cargo to run` — seven of them — while the binaries sat on
 * PATH.
 *
 * # Why links, not `RUSTUP_HOME` / `CARGO_HOME`
 *
 * Tried first, and measured wrong: the receipt's `cargo --version` recovered and
 * the arm still failed, because the tool under test spawns cargo through the
 * product's env scrub (`src/shared/env-scrub.ts`), which passes HOME and drops
 * both variables. Adding them to that allowlist is a product decision — a
 * `CARGO_HOME` config can set a `rustc-wrapper`. A link inside the scratch HOME is
 * reached through HOME itself, by every child, scrubbed or not — the same
 * mechanism the shard runner already uses to lend `~/Library` to browser workers.
 *
 * These are TOOLCHAIN roots, not Quanta state. A root is lent only if it exists,
 * so a host without Rust gets nothing. Writes through the link land where they
 * landed before the fence. Removing a scratch home removes the link, not what it
 * points at (`rmSync` does not follow links).
 *
 * Python's user site (`~/Library/Python/X.Y` on macOS) is NOT lent: it is under
 * `~/Library`, which only browser workers are lent on purpose, and a receipt says
 * when a package is hidden this way (`AVAILABLE under the caller's HOME`).
 *
 * Every place that replaces HOME lends through here — the fence, the shard
 * runner's worker and probe homes, the lane wrapper's home — so a probe and the
 * test it answers for see the same toolchains.
 */

import { mkdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"

export const TOOLCHAIN_HOME_LEAVES: readonly string[] = [".rustup", ".cargo"]

export interface ToolchainLink {
  readonly link: string
  readonly target: string
}

/** The links a scratch `home` needs, for each toolchain root present under `realHome`. */
export const toolchainLinks = (input: {
  readonly home: string
  /** The HOME being replaced; `undefined` when nothing real is being replaced. */
  readonly realHome: string | undefined
  readonly exists: (path: string) => boolean
}): readonly ToolchainLink[] => {
  const real = input.realHome?.trim()
  if (real === undefined || real === "" || real === input.home) return []
  return TOOLCHAIN_HOME_LEAVES.map((leaf) => ({
    link: join(input.home, leaf),
    target: join(real, leaf),
  })).filter((one) => input.exists(one.target))
}

/**
 * Create the links. An occupied link path is left alone — a test that made its own
 * `.cargo` owns it. Returns the links it created. Never throws: a toolchain that
 * cannot be lent shows up as the failing arm it would have been anyway.
 */
export const lendToolchainRoots = (links: readonly ToolchainLink[]): readonly string[] => {
  const created: string[] = []
  for (const { link, target } of links) {
    try {
      mkdirSync(join(link, ".."), { recursive: true })
      symlinkSync(target, link)
      created.push(link)
    } catch {
      // EEXIST: occupied — a test's own `.cargo`, or another process linked it
      // first — or a platform that refuses links.
    }
  }
  return created
}
