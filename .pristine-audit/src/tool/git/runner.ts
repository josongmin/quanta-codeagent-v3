/** `@/tool/git` runner re-export.
 *
 *  The generic git-exec EFFECT port + its `Bun.spawn` adapter were relocated
 *  to the LEAF slice `@/storage/git-runner` so non-tool consumers (notably
 *  `@/storage/shadow-odb`) no longer up-import the `@/tool` library layer.
 *  This thin re-export keeps every existing `@/tool/git` / `@/tool` consumer
 *  of `defaultGitRunner` / `buildGitEnv` compiling byte-unchanged. */
export { buildGitEnv, defaultGitRunner } from "@/storage/git-runner"
