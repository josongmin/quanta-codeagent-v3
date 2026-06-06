/** `@/storage/git-runner` — generic git-exec EFFECT port + its default
 *  `Bun.spawn`-backed adapter.
 *
 *  CANONICAL home for the {@link GitRunner} port (relocated out of `@/tool/git`
 *  so storage leaves consume the runner WITHOUT an up-import into the `@/tool`
 *  library layer). `@/tool/git` re-exports these names so every existing
 *  consumer keeps compiling unchanged. */
export { buildGitEnv, defaultGitRunner } from "./runner"
export type { GitRunner, GitRunResult } from "./types"
