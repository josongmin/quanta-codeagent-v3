import { realpathSync, statSync } from "node:fs"

/**
 * Host capability fingerprint for verification receipts.
 *
 * WHY IT EXISTS. A green verification result is reusable only while the host
 * can still do what that green covered. `contract` and `real-toolchain-e2e`
 * shell out to docker / python / the language servers, and both are SKIPPED
 * wholesale when an exact receipt is reused — so a receipt that does not
 * record those capabilities lets a host that has since lost docker replay a
 * green it can no longer earn.
 *
 * ABSENCE IS A VALUE. A missing tool fingerprints as `<missing>`, so gaining a
 * capability invalidates a receipt exactly as losing one does; otherwise the
 * "skipped because absent" runs and the "passed because present" runs would
 * share a fingerprint.
 *
 * NO SUBPROCESS. The first version ran `<tool> --version` per entry. That was
 * unbounded — one wedged CLI stalls the campaign with no diagnostic — and,
 * measured, 931ms, spent on the PRE-LEASE receipt probe whose entire purpose
 * is to return immediately when there is no campaign to serialize. Identity
 * now comes from the resolved binary itself: PATH resolution, symlink target,
 * size, mtime. That is strictly better at the job the fingerprint exists for
 * (a rebuilt binary that still prints the same version string changes size and
 * mtime) and the whole "the probe hung" class is gone.
 */

/**
 * Executables whose PRESENCE decides whether a host-dependent test runs.
 *
 * Harvested from the corpus, not guessed: these are the names the
 * `*-real-e2e.test.ts` lane and the contract suites resolve before deciding
 * to skip. The first version listed five plausible tools and missed `cargo`,
 * `go`, `gopls`, `rust-analyzer`, `clangd`, `lldb-dap`, `node` and `npm` — the
 * whole 43-case real-toolchain lane — so installing a Rust or Go toolchain
 * left the fingerprint identical and replayed a green earned while those
 * cases skipped. It also probed `pyright`, while the tests gate on
 * `pyright-langserver`.
 *
 * `tests/unit/dev/external-toolchain-coverage.test.ts` fails when the corpus
 * gains a gating binary this list does not carry.
 */
export const EXTERNAL_TOOLS = [
  "bun",
  "cargo",
  "clang++",
  "clangd",
  "dlv",
  "docker",
  "g++",
  "git",
  "go",
  "gopls",
  "lldb-dap",
  "node",
  "npm",
  "pyright-langserver",
  "python3",
  "rust-analyzer",
  "typescript-language-server",
  "uv",
] as const

export const probeToolVersion = (tool: string): string => {
  // Resolve against the CURRENT PATH, explicitly. `Bun.which(tool)` reads the
  // PATH the process started with and ignores later `process.env.PATH` changes
  // (measured on Bun 1.3.14), which would fingerprint a capability the
  // children will not actually see.
  const path = Bun.which(tool, { PATH: process.env.PATH ?? "" })
  if (path === null) return "<missing>"
  try {
    // Follow the symlink: `~/.bun/bin/<tool>` and `/usr/local/bin/<tool>` are
    // usually links, and an upgrade repoints them or replaces the target.
    const target = realpathSync(path)
    const stat = statSync(target)
    return `${path} -> ${target} ${stat.size} ${Math.round(stat.mtimeMs)}`
  } catch {
    // Present on PATH but unreadable is its own state — never silently equal
    // to a healthy tool.
    return `${path} <unreadable>`
  }
}

let cachedFingerprint: Record<string, string> | undefined

/** Probed once per process; an injected probe is never cached. */
export const externalToolchainFingerprint = (
  probe: (tool: string) => string = probeToolVersion,
): Record<string, string> => {
  if (probe === probeToolVersion && cachedFingerprint !== undefined) return cachedFingerprint
  const fingerprint = Object.fromEntries(EXTERNAL_TOOLS.map((tool) => [tool, probe(tool)]))
  if (probe === probeToolVersion) cachedFingerprint = fingerprint
  return fingerprint
}
