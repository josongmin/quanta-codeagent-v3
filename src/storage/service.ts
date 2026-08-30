import { mkdir, rename, stat, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { QuantaError, runtimeConfig } from "@/shared"
import { writeFileAtomic as writeFileAtomicRaw } from "./atomic-write"
// The symlink-aware create-then-escape defense is the ONE shared core (jul-27
// DRY audit — was byte-duplicated here + in fs-jail-lib.ts).
import { lexicalNormalize, realResolve } from "./canonicalize-core"
import type { FileInfo } from "./types"

/** Raised when a tool's filesystem access escapes its `ctx.cwd` jail root.
 *  Tools MUST catch this and surface `ok:false` — it is a hard stop, never a
 *  partial read/write. Mirrors the posture of `@/runtime`'s SandboxPolicyError
 *  but stays inside the storage slice (no cross-slice import). */
export class FsJailError extends QuantaError {
  readonly target: string | undefined
  readonly root: string | undefined

  constructor(message: string, opts?: { target?: string; root?: string }) {
    super("fs_jail", message)
    this.target = opts?.target
    this.root = opts?.root
  }
}

/** The FS jail is ON by default (secure-by-default). The escape hatch
 *  `QUANTA_FS_JAIL=off` is read ONCE at startup via {@link runtimeConfig}
 *  and frozen — mid-run env mutation does not flip it. */
const jailDisabled = (): boolean => runtimeConfig().fsJailDisabled

/**
 * ADR-0269 (Phase 3 of ADR-0239) — module-level optional decision sink.
 *
 * `enforceJail` is a free function called from dozens of tool catch sites
 * via the `resolvePath`/`resolveJailed` chokepoint. Threading a per-call
 * emitter parameter through every caller would ripple across the entire
 * tool slice for a default-OFF developer-mode signal. Instead we expose a
 * narrow setter the composition root wires ONCE (typically at `runAgent`
 * entry) and clears at exit. Lifecycle invariants:
 *   - Last-writer-wins: concurrent `runAgent` invocations in the same
 *     process share the sink; events still carry their own categorical
 *     `path` so a tracer can disambiguate. This is documented and
 *     accepted — the channel is observational telemetry, not authority.
 *   - The sink MUST be cleared on session end (see `loop-helpers#wire-up`).
 *   - The sink is invoked inside try/catch — a throwing consumer cannot
 *     poison the throw path (gate result stays stable).
 *
 * Default-OFF: no sink wired ⇒ zero allocation, zero behaviour change.
 *
 * Slice fence: `@/storage` MUST NOT depend on `@/stream`, so the sink shape
 * is declared inline as a STRUCTURAL mirror of `@/stream`'s `DecisionEvent`
 * (closed `kind`/`outcome` unions, same field names). The wiring layer
 * (which lives in `@/agent`, where `@/stream` is a legal dependency) passes
 * the real `DecisionEmitter` — the structural compat keeps both ends
 * type-checking without a cross-slice import.
 */
type FsJailDecisionEvent = {
  readonly type: "decision"
  readonly turn: number
  readonly kind: "permission" | "rule" | "hook" | "cap" | "jail" | "budget" | "objective"
  readonly outcome: "allow" | "deny" | "ask"
  readonly reason: string
  readonly toolCallId?: string
  readonly ruleId?: string
  readonly hookName?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

type FsJailDecisionSink = (event: FsJailDecisionEvent) => void

let fsJailDecisionSink: FsJailDecisionSink | null = null

/**
 * ADR-0269 — SINGLE SOURCE OF TRUTH for the `kind:"jail"` decision-event shape.
 *
 * Both this slice's {@link emitJailDeny} (the actual emit chokepoint) AND the
 * `@/agent` re-export `buildJailDecisionEvent` (for agent-slice consumers that
 * legally hold a `@/stream` `DecisionEmitter`) produce the jail event through
 * THIS builder, so the categorical `reason` / `metadata` shape can never drift
 * between the two construction sites.
 *
 * The builder lives HERE (not in `@/agent`) because the slice fence forbids
 * `@/storage` from importing `@/agent` / `@/stream` (it would create an
 * `agent → storage` cycle the slice-graph validator rejects). `@/agent` legally
 * imports `@/storage`, so the dependency points the allowed direction: the
 * agent builder DELEGATES to this one and re-casts the result to the
 * structurally-identical `@/stream` `DecisionEvent`.
 *
 * `path` is the canonicalized OFFENDING absolute path: the user supplied it
 * (so disclosure is already user-known) AND it was REJECTED, so the event does
 * NOT expose the file's contents. `turn` is `0` — the jail chokepoint is a
 * free function with no turn context; a tracer disambiguates by the categorical
 * `path` in `metadata`. */
export const buildFsJailDecisionEvent = (args: {
  readonly path: string
  readonly root: string
}): FsJailDecisionEvent => ({
  type: "decision",
  turn: 0,
  kind: "jail",
  outcome: "deny",
  reason: `path outside workspace: ${args.path}`,
  metadata: { path: args.path, root: args.root },
})

/** Wire the process-level fs-jail decision sink. The sink fires once per
 *  `enforceJail` rejection (i.e. once per FsJailError throw). The composition
 *  root is responsible for calling {@link clearFsJailDecisionSink} at the
 *  matching session-end boundary. Calling this with a non-null sink replaces
 *  any prior sink (last-writer-wins by design). */
export const setFsJailDecisionSink = (sink: { emit: FsJailDecisionSink }): void => {
  fsJailDecisionSink = (event) => sink.emit(event)
}

/** Clear the process-level fs-jail decision sink. Idempotent — calling
 *  twice is safe. The composition root MUST call this at session-end to
 *  avoid leaking the previous run's emitter into a sibling process-shared
 *  call graph. */
export const clearFsJailDecisionSink = (): void => {
  fsJailDecisionSink = null
}

/** Internal: fire the sink with a categorical jail-deny event. Try/catch
 *  isolation: a throwing sink cannot poison the throw path. Default-OFF
 *  branch: no sink wired ⇒ the function returns without allocating. */
const emitJailDeny = (offendingPath: string, jailRoot: string): void => {
  if (fsJailDecisionSink === null) return
  try {
    // SSOT — construct via the shared builder so the emitted shape can never
    // drift from the `@/agent` `buildJailDecisionEvent` re-export.
    fsJailDecisionSink(buildFsJailDecisionEvent({ path: offendingPath, root: jailRoot }))
  } catch {
    // Observational sink — never propagate a consumer failure into the
    // gate. The gate's deny posture MUST stay stable (the throw below is
    // the authoritative result; the emit is best-effort telemetry).
  }
}

/**
 * Branded path type.
 *
 * A `JailedPath` is an absolute path string that has been validated as
 * inside (or equal to) some jail root via {@link resolveJailed}. The brand
 * is at TYPE level only — at runtime it's a regular string — but the type
 * system makes it impossible to construct one from a raw string without
 * passing through the validator. Tools that touch the filesystem accept
 * `JailedPath`, not `string`; the seam between "user-supplied" and "safe to
 * spawn / open" is the brand.
 *
 * NEVER cast `string as JailedPath`. The anti-regression scanner forbids it
 * outside this file. The only legitimate constructor is {@link resolveJailed}.
 */
declare const JailBrand: unique symbol
export type JailedPath = string & { readonly [JailBrand]: true }

/** True iff `child` is the jail root itself or strictly inside it. Compared on
 *  segment boundaries so `/jailX` cannot pass a `/jail` root. */
const isInside = (root: string, child: string): boolean => {
  if (child === root) return true
  const prefix = root === "/" ? "/" : `${root}/`
  return child.startsWith(prefix)
}

/** Enforce the jail: resolve `requested` against `baseDir`, lexically and via
 *  realpath of the existing parent, and reject any final path that lands
 *  outside the `baseDir` root. Throws {@link FsJailError} on escape. Only
 *  invoked when a tool explicitly passes its `ctx.cwd` as `baseDir`. */
const enforceJail = (requested: string, baseDir: string, abs: string): string => {
  if (jailDisabled()) return abs
  const root = realResolve(lexicalNormalize(resolve(baseDir)))
  const target = realResolve(lexicalNormalize(abs))
  if (!isInside(root, target)) {
    // ADR-0269 — emit BEFORE throwing so the tracer pairs the decision row
    // with the throw site even when the FsJailError is caught + converted
    // to an `ok:false` ToolResult downstream. Default-OFF when no sink is
    // wired (zero allocation, byte-identical to pre-Phase-3 path).
    emitJailDeny(target, root)
    throw new FsJailError(
      `Path escapes the working-directory jail: "${requested}" resolves outside ${root}. ` +
        "Set QUANTA_FS_JAIL=off to allow cross-directory access.",
    )
  }
  return abs
}

/**
 * Test-only / composition-shared shim exposing `enforceJail` directly.
 *
 * Production code reaches the jail through `resolvePath` / `resolveJailed`
 * — the public API. The hellgate for ADR-0269 needs to exercise the jail
 * throw path without spinning up a full tool dispatch, so we re-export the
 * helper under its canonical name. Renamed-only export keeps the private
 * helper name (`enforceJail`) unchanged for grep stability inside this
 * file while still gating tests on the SAME function the tools use.
 */
export { enforceJail }

/**
 * Resolve a possibly-relative path against `baseDir` (default `process.cwd()`)
 * to an absolute path. An absolute `path` is returned unchanged. Tool callers
 * pass their session `ctx.cwd`; non-tool callers keep the cwd default.
 *
 * BACK-COMPAT SEAM. Prefer {@link resolveJailed} in NEW tool code — it
 * returns a branded `JailedPath` and refuses an empty/undefined `baseDir`
 * (the prior silent-bypass bug). This `resolvePath` keeps the pre-jail
 * `baseDir`-optional surface so existing non-tool callers (state.ts, session
 * meta) work unchanged.
 *
 * FS JAIL (secure-by-default): when a tool explicitly passes a `baseDir`
 * (its `ctx.cwd`), the resolved real path is confined to that jail root.
 * No-baseDir callers keep the exact pre-jail behavior for back-compat.
 * `QUANTA_FS_JAIL=off` opts out (read once at startup via `runtimeConfig`).
 */
export const resolvePath = (path: string, baseDir?: string): string => {
  const abs = resolve(baseDir || process.cwd(), path)
  if (baseDir !== undefined && baseDir !== "") return enforceJail(path, baseDir, abs)
  return abs
}

/**
 * The canonical "tool-supplied path → safe absolute path" constructor.
 *
 * Returns a {@link JailedPath} (branded). The brand is the only way for a
 * downstream tool (spawn/argv builder, Bun.Glob, LSP open) to receive a
 * path-typed value — the type system enforces that every spawn arg is
 * jail-validated.
 *
 * Refuses an empty or undefined `jailRoot`. The prior "baseDir is
 * `undefined`/`""` ⇒ skip the jail" code path was a silent-bypass surface:
 * a caller that forgot to thread `ctx.cwd` got the legacy un-jailed
 * behavior with no error.
 */
export const resolveJailed = (requested: string, jailRoot: string): JailedPath => {
  if (typeof jailRoot !== "string" || jailRoot.length === 0) {
    throw new FsJailError(
      "resolveJailed requires a non-empty jail root — caller must thread ctx.cwd explicitly",
    )
  }
  const abs = resolve(jailRoot, requested)
  return enforceJail(requested, jailRoot, abs) as JailedPath
}

export const readFile = async (path: string, baseDir?: string): Promise<string> => {
  try {
    // Do not stat this BunFile before reading it: exists() caches its size.
    // An atomic rename between exists() and text() then reads the NEW inode
    // using the OLD byte count, truncating a valid published JSON snapshot.
    return await Bun.file(resolvePath(path, baseDir)).text()
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error(`File not found: ${path}`)
    }
    throw error
  }
}

export const writeFile = async (path: string, content: string, baseDir?: string): Promise<void> => {
  const abs = resolvePath(path, baseDir)
  await Bun.write(abs, content)
}

export const statFile = async (path: string, baseDir?: string): Promise<FileInfo> => {
  const abs = resolvePath(path, baseDir)
  const s = await stat(abs)
  return {
    path: abs,
    size: s.size,
    isDirectory: s.isDirectory(),
    mtimeMs: s.mtimeMs,
    // B5 device guard — surface the device-type flags Node's `fs.Stats`
    // already computes so the `read` tool can reject FIFOs / device files
    // BEFORE opening them (a `read()` on a FIFO blocks the loop forever).
    isFIFO: s.isFIFO(),
    isCharacterDevice: s.isCharacterDevice(),
    isBlockDevice: s.isBlockDevice(),
  }
}

/**
 * B5 binary guard — read a BOUNDED leading window of a file as raw bytes
 * (jailed identically to {@link readFile}). The `read` tool sniffs the
 * returned bytes: a leading BOM (UTF-8 / UTF-16 LE/BE) marks text, and ONLY in
 * its ABSENCE is a NUL (`0x00`) the binary discriminator git and editors use.
 * (UTF-16 text IS full of NULs, so the BOM must be checked first — see
 * `read`'s `classifyEncoding`.) Reading only a bounded prefix means a
 * multi-gigabyte binary is NOT slurped into memory just to classify it.
 *
 * `maxBytes` is the caller-supplied window. Returns the actual bytes read
 * (`<= maxBytes`; shorter for a small file). Routes through {@link resolvePath}
 * so the FS jail applies exactly as it does for `readFile`/`statFile`.
 */
export const readFileBytes = async (
  path: string,
  maxBytes: number,
  baseDir?: string,
): Promise<Uint8Array> => {
  const file = Bun.file(resolvePath(path, baseDir))
  if (!(await file.exists())) throw new Error(`File not found: ${path}`)
  // `Bun.file().slice(0, n)` is a lazy view; `.bytes()` materializes ONLY the
  // bounded prefix — no full-file read for the binary sniff.
  const slice = file.slice(0, maxBytes)
  return slice.bytes()
}

export const fileExists = async (path: string, baseDir?: string): Promise<boolean> =>
  Bun.file(resolvePath(path, baseDir)).exists()

export const parentDir = (path: string, baseDir?: string): string =>
  dirname(resolvePath(path, baseDir))

/**
 * Jailed file delete. Resolves `path` through {@link resolvePath} (so an
 * explicit `baseDir` confines it to the same jail root as read/write/edit),
 * then unlinks. Added so `apply_patch` can route its delete op through the ONE
 * storage jail instead of carrying a second bespoke jail. */
export const deleteFile = async (path: string, baseDir?: string): Promise<void> => {
  await unlink(resolvePath(path, baseDir))
}

/**
 * Jailed file rename. BOTH endpoints go through {@link resolvePath}, so an
 * explicit `baseDir` jails the source AND the destination identically to the
 * read/write/edit chokepoint — neither end can escape. Creates the
 * destination's parent directory first (mirrors {@link writeFile}'s implicit
 * `Bun.write` mkdir). */
export const renameFile = async (from: string, to: string, baseDir?: string): Promise<void> => {
  const absFrom = resolvePath(from, baseDir)
  const absTo = resolvePath(to, baseDir)
  await mkdir(dirname(absTo), { recursive: true })
  await rename(absFrom, absTo)
}

/**
 * Injected filesystem port for the read/edit/write tools (#13). Mirrors the
 * jail-enforcing `@/storage` free functions so a tool can route every fs
 * call through one swappable seam — the same testability posture
 * `apply_patch`/git use (`FileSystemPort`/`GitRunner`). The jail logic stays
 * in {@link resolvePath}: each method still threads `baseDir` (the tool's
 * `ctx.cwd`), so a port substitution does NOT widen the jail.
 *
 * The production port is {@link defaultFileSystemPort}; tests pass an
 * in-memory stand-in. Behavior with the default is byte-identical to calling
 * the free functions directly.
 */
export interface FileSystemPort {
  readFile(path: string, baseDir?: string): Promise<string>
  writeFile(path: string, content: string, baseDir?: string): Promise<void>
  statFile(path: string, baseDir?: string): Promise<FileInfo>
  /** B5 binary guard — OPTIONAL bounded raw-byte read. The `read` tool calls
   *  this with a small leading window and rejects the file if the bytes contain
   *  a NUL (`0x00`) — the text/binary discriminator. OPTIONAL so existing
   *  in-memory test fakes (which do not implement it) stay valid; the `read`
   *  tool treats absence as "binary sniff unavailable ⇒ skip the binary check"
   *  (byte-identical legacy behavior for ports that predate this method). The
   *  default port implements it via {@link readFileBytes}. */
  readFileBytes?(path: string, maxBytes: number, baseDir?: string): Promise<Uint8Array>
  fileExists(path: string, baseDir?: string): Promise<boolean>
  /** ADR-0398 — OPTIONAL 2-phase temp+rename commit. When present, callers
   *  with a precondition (e.g. `edit`'s `expected_hash`) MAY route their
   *  on-disk commit through this method so the file is EITHER fully replaced
   *  OR untouched (no partial-write window). Callers MUST treat absence as
   *  "fall back to {@link writeFile}" — the existing in-memory test fakes do
   *  not implement this method, and the default-OFF tool path (no
   *  `expected_hash` supplied) never invokes it, so legacy ports remain
   *  byte-identical. */
  writeFileAtomic?(path: string, content: string, baseDir?: string): Promise<void>
}

const defaultWriteFileAtomic = async (
  path: string,
  content: string,
  baseDir?: string,
): Promise<void> => {
  const abs = resolvePath(path, baseDir)
  await writeFileAtomicRaw(abs, content)
}

/** Real `@/storage`-backed {@link FileSystemPort}. The default for every tool;
 *  using it leaves behavior byte-identical to the pre-port direct calls. */
export const defaultFileSystemPort: FileSystemPort = {
  readFile,
  writeFile,
  statFile,
  fileExists,
  writeFileAtomic: defaultWriteFileAtomic,
  readFileBytes,
}
