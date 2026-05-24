/**
 * Ambient module declaration for `write-file-atomic@8` (CJS, no bundled types
 * nor `@types/write-file-atomic` on the registry). Surface narrowed to the
 * subset `file-write-atomic-lib.ts` consumes:
 *
 *   - default export is the async `writeFile(filename, data, options?) → Promise<void>`
 *   - options: `mode` (octal chmod), `fsync` (default true), `chown`, `encoding`,
 *     `tmpfileCreated` (hook fired with the temp path post-create)
 *
 * Sync export (`.sync`) + internal helpers (`._getTmpname`, `._cleanupOnExit`)
 * are intentionally omitted. `skipLibCheck: true` is set in tsconfig — a
 * future caller that needs them can extend this file without churn.
 */

declare module "write-file-atomic" {
  export interface WriteFileOptions {
    mode?: number
    chown?: { uid: number; gid: number }
    encoding?: string
    fsync?: boolean
    tmpfileCreated?: (tmpPath: string) => Promise<void> | void
  }

  function writeFile(
    filename: string,
    data: string | NodeJS.ArrayBufferView,
    options?: WriteFileOptions,
  ): Promise<void>

  export default writeFile
}
