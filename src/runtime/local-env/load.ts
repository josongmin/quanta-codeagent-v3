/**
 * Config-file discovery for the local-environment slice (ADR-0455).
 *
 * Walks CWD → repo-root (the SAME boundary contract `loadRepoRules` uses: stop
 * at a `.git` dir or the filesystem root, capped depth) looking for the FIRST
 * environment config. Candidate filenames, in priority order:
 *   1. `.quanta/environment.toml`   (canonical, quanta-native)
 *   2. `.codex/environments/environment.toml`  (Codex-compat absorption)
 *
 * Returns `undefined` when NO config exists anywhere on the walk — that is the
 * default-OFF path (ambient env inherited unchanged). The body is parsed by
 * {@link parseLocalEnvConfig}; a malformed file yields a typed error result so
 * the caller can fail closed instead of silently ignoring a broken config.
 *
 * NO HEURISTICS: the only thing detected is the PRESENCE of a DECLARED config
 * file. Nothing about the environment itself is sniffed.
 */

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseLocalEnvConfig } from "./parse"
import type { LocalEnvParseResult, TomlParse } from "./types"

/** Candidate config paths relative to a directory, highest priority first. */
export const LOCAL_ENV_CANDIDATES = [
  join(".quanta", "environment.toml"),
  join(".codex", "environments", "environment.toml"),
] as const

/** Max directories the walk visits (mirrors the repo-rules guard). */
const MAX_DEPTH = 64

export interface LoadLocalEnvResult {
  /** Absolute path of the config that was found + parsed. */
  readonly sourcePath: string
  /** The typed parse outcome for that file (ok or fail-closed error). */
  readonly result: LocalEnvParseResult
}

const tryRead = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined // ENOENT / EACCES / EISDIR — treat as absent, keep walking
  }
}

/**
 * Discover + parse the nearest local-env config from `cwd` up to repo root.
 * Returns `undefined` when none exists (default-OFF). `toml` is the injected
 * TOML parser (DI) — pass `Bun.TOML.parse` at the composition root, a stub in
 * tests.
 */
export const loadLocalEnvConfig = async (
  cwd: string,
  toml: TomlParse,
): Promise<LoadLocalEnvResult | undefined> => {
  let dir = resolve(cwd)
  for (let i = 0; i < MAX_DEPTH; i++) {
    for (const candidate of LOCAL_ENV_CANDIDATES) {
      const sourcePath = join(dir, candidate)
      const body = await tryRead(sourcePath)
      if (body !== undefined) {
        return { sourcePath, result: parseLocalEnvConfig(body, toml) }
      }
    }
    if (existsSync(join(dir, ".git"))) break
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
  }
  return undefined
}
