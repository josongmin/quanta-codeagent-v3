# The repo-root fixture leak: what is known, and what four methods failed to find

**Status: UNRESOLVED source. Detection is in place; the writer is not identified.**

This records an investigation that did not reach its goal, so the next person
does not repeat the four approaches that already failed.

## The symptom

A full `bun test tests/unit` leaves three untracked files at the repo root:

| path | bytes | content |
|---|---|---|
| `src/x.ts` | 7 | `no edit` |
| `rel.txt` | 5 | `based` |
| `round.txt` | 9 | `jailed-ok` |

All three are test FIXTURES by content. `rel.txt` holds exactly the bytes
`tests/unit/storage.test.ts` writes; `round.txt` exactly what `fs-jail.test.ts`
writes; `src/x.ts` exactly the `"no edit"` payload in
`dispatch-lint-delta-hellgate.test.ts`. None of those three tests can be the
writer on its own — each passes a temp `baseDir`, and `resolvePath` resolves a
relative path against the base, never `process.cwd()`.

## Why it costs more than a dirty tree

The suite POISONS ITSELF. `storage.test.ts` asserts that a relative name does
**not** exist under `process.cwd()`:

```ts
await writeFile("rel.txt", "based", dir)
…
expect(await fileExists("rel.txt")).toBe(false)   // ← fails on the NEXT run
```

So one leaking run makes the following run red, deterministically, with no
ordering or load involved. `src/x.ts` is worse: it is not valid TypeScript, so
it fails `typecheck:all` (TS1434), adds two `lint` errors, and — because
`lint:debt` is a CLOSED universe — fails that gate too, all in a file no commit
contains. The aug-23 incident was three gates red at once with nothing wrong in
`git log`.

## What IS established

- **It is an INTERACTION, not one test.** `bun test tests/unit --shard=1/2` and
  `--shard=2/2` were each run to completion: NEITHER produces any of the three
  files. The full run produces all three. Running the three suspect files alone
  produces nothing.
- **Timing within a 278 s full run** (from a timestamped run with a 20 ms
  poller): `src/x.ts` at +170 s, `rel.txt` at +239 s, `round.txt` at +254 s.
- **The write is not visible at the obvious fs seams.** A `--preload` hook over
  `Bun.write`, `fs.writeFileSync`, `fs.appendFileSync`, `fsp.writeFile`,
  `fsp.appendFile`, `fs.createWriteStream`, `fs.openSync`, `fsp.open`,
  `fs.renameSync`, `fsp.rename`, `copyFile*`, `link*`, `symlink*` and `mkdir`
  logged NOTHING across a full run in which all three files appeared. The hook
  is not blind: a self-check that writes `round.txt` through `Bun.write`, and a
  second through `writeFileAtomic`, are both recorded when driven directly.
- **`Bun.spawn`/`spawnSync` with `cwd` = repo root** was hooked too. Nothing.

## The four approaches that failed, and why

1. **Namespace monkey-patching in a preload.** This is the likely reason the
   hooks saw nothing in the suite while working in a self-check. `writeFileAtomic`
   uses `import { open, rename } from "node:fs/promises"` — ESM named bindings,
   resolved at module load. Patching the *namespace object* returned by
   `require("node:fs/promises")` does not affect a module that imported the
   bindings directly. Any future hook has to intercept at the module-resolution
   layer (a `Bun.plugin` `onLoad` rewrite) rather than by assignment.
2. **Correlating appearance time with test output.** `bun test` buffers per file
   and prints headers only for files with output, so a timestamped stdout stream
   has nothing to correlate a wall-clock hit against.
3. **Occupying the paths as DIRECTORIES** so the write fails loudly with EISDIR.
   The decoy directories survived a full run untouched, and no EISDIR naming any
   of the three paths appeared. Either the write is attempted and its error is
   swallowed, or it never reaches a syscall this decoy can catch. (The decoy does
   produce one unrelated failure — `src/x.ts` as a directory breaks the arch scan
   that reads every `src/**/*.ts`.)
4. **Shard bisection.** Both halves are clean; the interaction spans them.

## What IS in place

`tools/dev/worktree-pollution-guard.ts` measures the untracked-path DELTA across
a command and fails on anything the run created. It is wired into CI's `unit`,
`integration` and PTY-e2e steps, and available locally as
`bun run test:pollution`. It caught this leak on the run that produced it, with
byte counts and content previews — which is how the three files above were
identified. Detection is solved; attribution is not.

## Suggested next step

The remaining untried lever is a `Bun.plugin` `onLoad` transform in the preload
that rewrites `node:fs` / `node:fs/promises` imports to a recording shim, which
is the only interception point that survives ESM named binding. Failing that,
bisect by *pairs* of directories rather than by shard, since the interaction is
what has to be reproduced, not any single file.
