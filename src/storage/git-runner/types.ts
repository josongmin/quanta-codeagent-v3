/** Generic git-exec EFFECT port — the {@link GitRunner} contract + its result
 *  shape.
 *
 *  This is the CANONICAL home for the port (relocated out of `@/tool/git` so
 *  leaf slices such as `@/storage/shadow-odb` can consume the runner without an
 *  UP-import into the `@/tool` library layer — ADR layering / slice-graph
 *  invariant). `@/tool/git` re-exports these names so every existing
 *  `@/tool/git` consumer keeps compiling unchanged.
 *
 *  Slice isolation: this leaf depends only on its own files + `Bun.spawn` +
 *  the ambient env (see {@link ./runner}). No `@/*` slice import. */

export interface GitRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitRunner {
  /** Run `git <args>` in `cwd`. The optional `signal` is propagated so a
   *  cancelled tool call (loop abort, subagent cancel, side-conversation budget
   *  exhaustion) actually kills the spawned `git` instead of leaking the
   *  process for the full {@link import("./runner").defaultGitRunner} timeout.
   *  Added optionally to preserve the existing fake-runner test surface
   *  (callers without a signal still type-check and behave identically). */
  run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitRunResult>
}
