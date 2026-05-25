/**
 * Default {@link VendorDetectorPort} implementation — node:fs/promises adapter.
 *
 * Walks every entry in `VENDOR_TABLE`, expands its `paths` per `PathKind`, and
 * delegates parsing to the pure `normalizer.ts`. Returns a typed
 * `DetectionResult`; never throws across the port boundary.
 *
 * Security:
 *   - Symlinks (file OR directory) are rejected (`lstat().isSymbolicLink()`).
 *     A symlinked rule file could point at a secret (`~/.ssh/id_rsa`) and
 *     its body would ride into the prompt as authority. Mirrors
 *     `glob-rules.ts:tryLoadRule`.
 *   - The detector resolves the result to `realpath` ONLY for the collision-
 *     resolution key so two vendors symlinking to the same physical file are
 *     deduped — but the user-visible `sourcePath` is the LOGICAL path, so
 *     diagnostics tell the user where they wrote the file (not where the
 *     symlink resolved). For our purposes here we use the absolute path
 *     after `path.resolve` and do not follow symlinks (consistent with the
 *     no-symlink security posture above).
 *
 * Caps:
 *   - `maxFiles` (default 256) bounds the TOTAL files opened, across vendors.
 *     Once hit, remaining vendor entries are skipped (and surfaced as one
 *     truncation marker error so the consumer can detect it).
 *   - `maxBodyBytes` (default 16 KiB) is per-file; enforced in normalizer.
 *   - Files larger than `maxBodyBytes * 2` on disk are skipped without
 *     reading (avoids a hostile 1 GiB file blowing memory before we get to
 *     truncate).
 *
 * Determinism:
 *   - Vendor iteration follows `VENDOR_TABLE` order.
 *   - Within a vendor, paths follow declaration order.
 *   - Within a directory, entries are sorted lexicographically by basename
 *     BEFORE filtering, so the cap-trip point is the same across runs.
 */

import { lstat, readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { DEFAULT_MAX_BODY_BYTES, normalizeOne, resolveCollisions } from "./normalizer"
import type {
  DetectedRule,
  DetectionResult,
  DetectOptions,
  DetectorError,
  VendorDetectorPort,
} from "./port"
import type { PathEntry, VendorDescriptor } from "./vendor-table"
import { VENDOR_TABLE } from "./vendor-table"

/** Default cap on number of files opened across all vendors. Matches
 *  `glob-rules.MAX_RULE_FILES` so callers see the same DoS-bound. */
export const DEFAULT_MAX_FILES = 256

/** Internal accumulator threaded through every vendor pass. Mutates only via
 *  the helpers in this file; never escapes. */
interface Accumulator {
  readonly rules: DetectedRule[]
  readonly errors: DetectorError[]
  filesOpened: number
  capTripped: boolean
}

class DefaultVendorDetector implements VendorDetectorPort {
  public async detectAll(opts: DetectOptions): Promise<DetectionResult> {
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
    const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    const acc: Accumulator = {
      rules: [],
      errors: [],
      filesOpened: 0,
      capTripped: false,
    }

    const absCwd = resolve(opts.cwd)
    for (const vendor of VENDOR_TABLE) {
      if (acc.capTripped) break
      for (const entry of vendor.paths) {
        if (acc.capTripped) break
        await ingestEntry({
          vendor,
          entry,
          absCwd,
          acc,
          maxFiles,
          maxBodyBytes,
        })
      }
    }

    if (acc.capTripped) {
      acc.errors.push({
        vendor: "quanta", // synthetic — not tied to a real source file
        sourcePath: "",
        message: `file cap (${maxFiles}) reached; later vendor entries skipped`,
      })
    }

    return {
      rules: resolveCollisions(acc.rules),
      errors: Object.freeze(acc.errors),
    }
  }
}

/** Public factory. Stateless — the returned instance can be shared. */
export const createDefaultVendorDetector = (): VendorDetectorPort => new DefaultVendorDetector()

// ─── per-entry ingestion ────────────────────────────────────────────────────

interface IngestArgs {
  readonly vendor: VendorDescriptor
  readonly entry: PathEntry
  readonly absCwd: string
  readonly acc: Accumulator
  readonly maxFiles: number
  readonly maxBodyBytes: number
}

const ingestEntry = async (args: IngestArgs): Promise<void> => {
  switch (args.entry.kind) {
    case "file":
      await ingestFile(args)
      return
    case "dir":
      await ingestDir(args)
      return
    case "mode-dir":
      await ingestModeDir(args)
      return
  }
}

const ingestFile = async (args: IngestArgs): Promise<void> => {
  if (args.acc.filesOpened >= args.maxFiles) {
    args.acc.capTripped = true
    return
  }
  const abs = join(args.absCwd, args.entry.path)
  await loadAndPush({ ...args, abs })
}

const ingestDir = async (args: IngestArgs): Promise<void> => {
  const abs = join(args.absCwd, args.entry.path)
  let names: string[]
  try {
    // Reject the dir itself if it's a symlink — same rationale as for files.
    const st = await lstat(abs)
    if (!st.isDirectory() || st.isSymbolicLink()) return
    names = await readdir(abs)
  } catch {
    return // ENOENT / EACCES / not a dir ⇒ vendor absent
  }
  for (const name of [...names].sort()) {
    if (args.acc.filesOpened >= args.maxFiles) {
      args.acc.capTripped = true
      return
    }
    if (!args.entry.extensions.some((ext) => name.endsWith(`.${ext}`))) continue
    await loadAndPush({ ...args, abs: join(abs, name) })
  }
}

/** Walk one matched mode-directory: stat it, readdir, load each matching file. */
const ingestOneModeSubdir = async (
  args: IngestArgs,
  dirAbs: string,
  mode: string,
): Promise<void> => {
  let dirStat: Awaited<ReturnType<typeof lstat>>
  try {
    dirStat = await lstat(dirAbs)
  } catch {
    return
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return
  let names: string[]
  try {
    names = await readdir(dirAbs)
  } catch {
    return
  }
  for (const name of [...names].sort()) {
    if (args.acc.filesOpened >= args.maxFiles) {
      args.acc.capTripped = true
      return
    }
    if (!args.entry.extensions.some((ext) => name.endsWith(`.${ext}`))) continue
    await loadAndPush({ ...args, abs: join(dirAbs, name), mode })
  }
}

const ingestModeDir = async (args: IngestArgs): Promise<void> => {
  // `path` is the prefix (`.roo/rules-`). The parent is `.roo/`; the
  // mode-tagged subdirectories are siblings whose names start with
  // `rules-`. We walk `.roo/`, filter by prefix, and treat each match as
  // its own ingest pass with `mode` set.
  const parent = join(args.absCwd, args.entry.path).replace(/[/\\][^/\\]*$/, "")
  const prefixBasename = args.entry.path.split(/[/\\]/).pop() ?? ""
  let modeDirs: string[]
  try {
    modeDirs = await readdir(parent)
  } catch {
    return // `.roo` absent
  }
  for (const dirName of [...modeDirs].sort()) {
    if (args.acc.capTripped) return
    if (!dirName.startsWith(prefixBasename)) continue
    const mode = dirName.slice(prefixBasename.length)
    if (mode === "") continue // bare `.roo/rules-` with no mode tag — skip
    await ingestOneModeSubdir(args, join(parent, dirName), mode)
  }
}

/** Final per-file step: lstat + readFile + normalize + push. */
const loadAndPush = async (
  args: IngestArgs & { readonly abs: string; readonly mode?: string },
): Promise<void> => {
  args.acc.filesOpened += 1
  let st: Awaited<ReturnType<typeof lstat>>
  try {
    st = await lstat(args.abs)
  } catch {
    return // ENOENT
  }
  if (st.isSymbolicLink() || !st.isFile()) return
  // Whole-file size cap: refuse to even read a file > 2× per-file body cap.
  // Truncation inside normalizer would still need to hold the whole text.
  if (st.size > args.maxBodyBytes * 2) {
    args.acc.errors.push({
      vendor: args.vendor.vendor,
      sourcePath: args.abs,
      message: `file size ${st.size} exceeds 2x body cap (${args.maxBodyBytes * 2})`,
    })
    return
  }
  let raw: string
  try {
    raw = await readFile(args.abs, "utf8")
  } catch {
    return
  }
  const result = normalizeOne({
    vendor: args.vendor,
    sourcePath: args.abs,
    rawText: raw,
    parser: args.entry.parser,
    maxBodyBytes: args.maxBodyBytes,
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
  })
  if (result.rule) args.acc.rules.push(result.rule)
  if (result.error) args.acc.errors.push(result.error)
}
