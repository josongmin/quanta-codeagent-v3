/**
 * Unified FsJail entry-point for document & image readers (Slice S7).
 *
 * BEFORE: each reader (`csv_read`, `ndjson_read`, `pdf_read`, `yaml_read`,
 * `read_image`, …) rolled its own `resolveXxxPath` that did a `path.resolve`
 * + `startsWith` containment check. Five copies, five subtle drift surfaces
 * (an absolute path that landed under cwd was allowed, but the realpath of
 * its existing parent was NEVER consulted — so a symlinked ancestor could
 * smuggle a final path outside the jail with no error).
 *
 * AFTER: every reader threads its raw input here. We delegate to the
 * canonical {@link resolveJailed} chokepoint in `@/storage/service` (which
 * does lexical normalize + realpath of the existing parent + segment-boundary
 * containment) and add two pre-conditions the storage layer does not need
 * to enforce (empty path / NUL byte). The branded {@link resolveJailed}
 * return is unwrapped to a plain `string` — readers feed downstream APIs
 * (`Bun.file`, `lstat`) that take `string`, NOT `JailedPath`. That unwrap
 * is the documented seam; downstream tools still get the safety because
 * the path was validated before the unwrap.
 *
 * NEW DOCUMENT TOOLS: import {@link resolveJailedDoc}. Do NOT roll your own.
 * The anti-regression test in `tests/unit/tool/_shared-resolve-jailed-doc-
 * hellgate.test.ts` seals the FsJailError-bubble contract; bypassing this
 * helper drops back into the pre-S7 fragmentation and re-opens the symlink-
 * escape gap.
 *
 * Slice posture (RFC §3.1): imports ONLY from `@/storage` (canonical jail);
 * NO `@/agent`, `@/permission`, `@/runtime`. Tools call this helper from
 * their own preflight — the helper does not know about `ToolResult`.
 */

import { FsJailError, resolveJailed } from "@/storage"

/**
 * Resolve a tool-supplied path against `cwd` through the canonical FS jail.
 *
 * Returns the resolved absolute path as a plain `string` (the brand is
 * unwrapped for downstream string-typed APIs — see file header for why).
 *
 * Throws {@link FsJailError} on:
 *   - empty `rawPath` (an empty input cannot be meaningfully jailed)
 *   - NUL byte (`\0`) in `rawPath` (path-truncation attack vector)
 *   - jail escape (delegated to {@link resolveJailed})
 *
 * The `kind` argument is a short identifier (e.g. `"image"`, `"csv"`) that
 * the helper prepends to error messages so a caller's typed-failure shows
 * which reader saw the violation — useful for tail-log triage when the same
 * symlink shows up in multiple tools' diagnostics.
 */
export function resolveJailedDoc(cwd: string, rawPath: string, kind: string): string {
  if (rawPath === "") {
    throw new FsJailError(`${kind}: empty path is not allowed`)
  }
  if (rawPath.includes("\0")) {
    throw new FsJailError(`${kind}: NUL byte in path is not allowed`)
  }
  // Brand-unwrap: downstream Bun.file / lstat take `string`. The validation
  // happened in `resolveJailed`; the brand-strip is intentional, not a cast-
  // around-safety. Scanner exception lives in `.scanner-exceptions.yaml`.
  return resolveJailed(rawPath, cwd) as string
}
