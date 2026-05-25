/**
 * Ambient module declaration for `write-file-atomic@8` (CJS, no bundled types
 * nor `@types/write-file-atomic` on the registry). Surface narrowed to the
 * subset `fs-backed-store.ts` consumes:
 *
 *   - default export is the async `writeFile(filename, data, options?) → Promise<void>`
 *
 * Mirrors the shape used in `src/lsp/adapters/file-write-atomic-lib.ts` (the
 * ADR-0185 swap site). This local sibling declaration scopes the type to
 * this slice so the import resolves without a project-wide types update.
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
