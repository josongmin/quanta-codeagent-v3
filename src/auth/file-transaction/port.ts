/**
 * Domain-injected exclusive file lock. Library slices other than `@/auth`
 * must not import this module; they declare the same structural port locally
 * or accept it as a constructor argument.
 */

export type ExclusiveLockUnavailable = {
  readonly ok: false
  readonly reason: "timeout" | "aborted" | "reentrant" | "io"
}

export type ExclusiveFileLockPort = {
  withExclusiveLock<T>(
    path: string,
    opts: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined },
    fn: () => Promise<T>,
  ): Promise<T>
}
