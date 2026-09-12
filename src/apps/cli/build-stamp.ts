/**
 * The compiled binary's own identity, baked at build time.
 *
 * # The problem this exists for
 *
 * `~/.local/bin/quanta` is a compiled single-file binary. Nothing in it recorded
 * WHICH source it was built from, and `--version` could not tell you: it reports
 * `package.json.version`, which only changes when the install script bumps it. A
 * binary hundreds of commits behind printed the same string as a fresh one. The
 * repo's own README already names this the number-one cause of "I fixed it and the
 * CLI did not change".
 *
 * # Why env-prefix inlining and not `--define`
 *
 * `bun build` has no `--define` flag. Measured on bun 1.3.14: `bun build --help`
 * contains no such option, and passing `--define:__X__='"1"'` exits 0 while
 * substituting NOTHING — so the obvious implementation fails silently and ships an
 * unstamped binary that looks stamped. `--env='QUANTA_BUILD_*'` does work: the
 * build inlines matching `process.env` reads as literals. Verified by running the
 * produced binary from OUTSIDE the repo with the vars unset.
 *
 * Outside a build these reads are ordinary env reads and return undefined, so
 * running from source is byte-identical to before.
 *
 * # Reading from outside the repo is the only honest test
 *
 * `resolveVersion` walks up for a `package.json`. Inside the repo that walk
 * succeeds and masks a missing stamp, which is the same trap
 * `compiled-binary-asset-parity` records for wasm assets. Any check of this must
 * `cd` somewhere else first.
 *
 * Slice note: leaf. Three env reads, no imports.
 */

/** Short commit the binary was built from. `undefined` ⇒ not a stamped build
 *  (running from source, or a build that bypassed the build script). */
export const BUILD_COMMIT: string | undefined = process.env.QUANTA_BUILD_COMMIT

/** `"1"` ⇒ the tree had uncommitted changes at build time. A stamp that omits
 *  this would let a dirty build claim a clean commit's identity. */
export const BUILD_DIRTY: boolean = process.env.QUANTA_BUILD_DIRTY === "1"

/** ISO-8601 build time. Distinguishes two builds of the same commit. */
export const BUILD_TIME: string | undefined = process.env.QUANTA_BUILD_TIME

/**
 * Compose the commit suffix: `abc123def456`, or `abc123def456-dirty` when the tree
 * was modified at build time. `undefined` when unstamped.
 *
 * PURE, and the parameters are why. The module constants are read from
 * `process.env` at LOAD, so from source they are permanently unstamped and clean —
 * measured: deleting the `-dirty` branch left the suite green because nothing
 * could reach it. A dirty build silently claiming a clean commit's identity is
 * worse than no stamp at all, so the branch is a function of its inputs.
 */
export const composeCommitLabel = (
  commit: string | undefined,
  dirty: boolean,
): string | undefined => {
  if (commit === undefined || commit.length === 0) return undefined
  return dirty ? `${commit}-dirty` : commit
}

/** The label for THIS process, from the values baked into this binary. */
export const buildCommitLabel = (): string | undefined =>
  composeCommitLabel(BUILD_COMMIT, BUILD_DIRTY)
