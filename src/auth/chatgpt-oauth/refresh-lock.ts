/**
 * Production ChatGPT refresh lock: one store root under quanta home.
 *
 * Token files live in `home/auth/`; the lock store must NOT follow the token
 * directory or LLM and bench will miss each other.
 */

import { FileBasedLock } from "../lock-file-based"
import { createNodeLockFileStore } from "../node-lock-file-store"
import type { OAuthRefreshLockPort } from "../oauth-refresh-lock"
import { chatgptRefreshLockDir, resolveQuantaHome } from "./paths"

export interface ChatgptRefreshLockOptions {
  readonly env: Record<string, string | undefined>
  readonly nowMs: () => number
  readonly pid: number
}

export const createChatgptRefreshLock = (opts: ChatgptRefreshLockOptions): OAuthRefreshLockPort =>
  new FileBasedLock({
    store: createNodeLockFileStore(chatgptRefreshLockDir(resolveQuantaHome(opts.env))),
    clock: { now: opts.nowMs },
    pid: opts.pid,
  })
