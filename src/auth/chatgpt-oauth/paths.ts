import { homedir } from "node:os"
import { join } from "node:path"

/** Resolve the home directory used for quanta state. Mirrors the seam used
 *  by `src/apps/cli/slash-commands.ts` (`QUANTA_PREFS_HOME` env override
 *  before `os.homedir()/.quanta`) so a single env knob isolates tests
 *  across every quanta surface. */
export const resolveQuantaHome = (env: Record<string, string | undefined>): string => {
  const override = env.QUANTA_PREFS_HOME
  if (override !== undefined && override !== "") return override
  return join(homedir(), ".quanta")
}

/** Disk path for the ChatGPT-OAuth token JSON. */
export const chatgptTokenPath = (home: string): string => join(home, "auth", "chatgpt.json")

/** Cross-process refresh lock directory. Shared by the LLM adapter and bench
 *  fresh-auth so the same token file serializes even when the token lives under
 *  `home/auth/` rather than `home/`. */
export const chatgptRefreshLockDir = (home: string): string => join(home, "locks")

/** Resolve the home directory used for Codex state. The desktop app exports
 *  `CODEX_HOME`; when absent we mirror its default `~/.codex`. */
export const resolveCodexHome = (env: Record<string, string | undefined>): string => {
  const override = env.CODEX_HOME
  if (override !== undefined && override !== "") return override
  return join(homedir(), ".codex")
}

/** Disk path for Codex's auth bundle. */
export const codexAuthPath = (home: string): string => join(home, "auth.json")
