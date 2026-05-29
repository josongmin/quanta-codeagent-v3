/**
 * Per-tool auto-record cadence wire (ADR-0309 — third of the three R2 wires).
 *
 * Closes the deferred last-mile from ADR-0300: today the granular registry
 * (`@/agent/checkpoint/granular-registry`) is never populated — no caller
 * records snapshots, so `/rewind-tool` against the new snapshot adapter
 * always returns `not-found`. This recorder wraps the surface-owned tool
 * registry so EVERY mutating tool call captures its `filesBefore` +
 * `taskMessagesBefore` into the registry pre-execute.
 *
 * # Plane-clean
 *
 * - Imports ONLY `@/agent/checkpoint/granular-registry` (registry port) and
 *   `@/tool` (Tool type via `@/tool/types`). File reads go through an
 *   INJECTED `readFile` port so this module never touches `node:fs/promises`
 *   directly (the surface composer binds the production `fs.readFile`).
 * - NO touch to `@/agent/dispatch`, `@/agent/loop*`, `@/tool/index`.
 * - The recorder wraps tools at the surface layer; the agent loop sees the
 *   wrapped registry transparently and is byte-identical when the env knob
 *   is OFF (the wrap is never constructed).
 *
 * # No-throw contract
 *
 * Every snapshot-capture step is wrapped in try/catch — a misbehaving
 * registry, a missing file, or a thrown reader NEVER bubbles up to the
 * tool execute path. The pre-state may be partial or empty; the tool
 * execute itself ALWAYS runs.
 */

import type { GranularRegistryPort } from "@/agent/checkpoint/granular-registry"
import type { Message } from "@/llm"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
/** Construction options. Each port is injected so unit tests can pin the
 *  recorder's behavior without touching the real registry / file system. */
export interface PerToolSnapshotRecorderOpts {
  /** Where the snapshot lands. The surface composer instantiates ONE
   *  registry per session via `defaultGranularRegistry()`. */
  readonly registry: GranularRegistryPort
  /** Inject the file-read port. Production wire binds
   *  `(path) => fs.readFile(path, "utf8").catch(() => null)`; tests inject
   *  an in-memory map. Returning `null` for any path causes the recorder
   *  to OMIT that path from `filesBefore` (no throw, partial snapshot). */
  readonly readFile?: (path: string) => Promise<string | null>
  /** Closure over the surface's live transcript. Read just before the
   *  tool executes so the snapshot reflects the exact `messages[]` the
   *  next turn would see. Empty array is fine. */
  readonly getCurrentMessages: () => readonly Message[]
  /** Closure over the surface's turn counter. Stored in the snapshot for
   *  diagnostics — not used for ordering by the registry. */
  readonly getCurrentTurn: () => number
  /** Inject the clock — tests pin to assert deterministic `takenAt`.
   *  Default: `Date.now`. */
  readonly now?: () => number
  /** Extract file paths to snapshot from a tool input. The surface
   *  composer wires a tool-name-aware function (e.g. read `input.path`
   *  for `write`/`edit`/`read`; return `[]` for non-file tools). When
   *  absent, NO paths are snapshotted — every snapshot has an empty
   *  `filesBefore`. Pure, no-throw; the recorder wraps in try/catch
   *  defensively. */
  readonly extractPaths?: (toolName: string, input: unknown) => readonly string[]
  /** Inject the toolCallId minter. Production binds `crypto.randomUUID`;
   *  tests pin to a counter. Default: `crypto.randomUUID`. */
  readonly mintToolCallId?: () => string
  /** Optional logger. The recorder calls `warn` on registry failures or
   *  thrown readers — every callback is otherwise silent. Absent ⇒ no
   *  warn surface (the no-throw contract still holds). */
  readonly logger?: { readonly warn: (m: string) => void }
}

/** Public surface returned by {@link createPerToolSnapshotRecorder}. */
export interface PerToolSnapshotRecorder {
  /** Wrap a single tool so every `execute(input, ctx)` first records a
   *  pre-state snapshot into the registry. Returns a NEW `Tool` value —
   *  the original is left unmutated. Preserves every optional surface
   *  field (`hitlTier`, `extractShellCommand`, `classifySource`,
   *  `toModelOutput`, …) via spread. */
  wrapTool<I, O>(tool: Tool<I, O>): Tool<I, O>
}

/** Read the configured paths into a `Map<path, content>`. Skips paths whose
 *  reader returns `null` (file missing / unreadable). Every step is
 *  wrapped — a thrown reader logs a warn and the path is omitted. */
const buildFilesBefore = async (
  paths: readonly string[],
  readFile: (path: string) => Promise<string | null>,
  logger: { readonly warn: (m: string) => void } | undefined,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  for (const path of paths) {
    try {
      const content = await readFile(path)
      if (content === null) continue
      out.set(path, content)
    } catch (e) {
      logger?.warn(`per-tool-snapshot-recorder: readFile threw for ${path}: ${errMessage(e)}`)
    }
  }
  return out
}

const safeExtractPaths = (
  extractor: ((toolName: string, input: unknown) => readonly string[]) | undefined,
  toolName: string,
  input: unknown,
  logger: { readonly warn: (m: string) => void } | undefined,
): readonly string[] => {
  if (extractor === undefined) return []
  try {
    return extractor(toolName, input)
  } catch (e) {
    logger?.warn(`per-tool-snapshot-recorder: extractPaths threw for ${toolName}: ${errMessage(e)}`)
    return []
  }
}

/** Build the recorder. Pure — construction performs NO I/O. */
export const createPerToolSnapshotRecorder = (
  opts: PerToolSnapshotRecorderOpts,
): PerToolSnapshotRecorder => {
  const registry = opts.registry
  const readFile = opts.readFile
  const getCurrentMessages = opts.getCurrentMessages
  const getCurrentTurn = opts.getCurrentTurn
  const now = opts.now ?? Date.now
  const extractPaths = opts.extractPaths
  const mintToolCallId = opts.mintToolCallId ?? (() => crypto.randomUUID())
  const logger = opts.logger

  const captureSnapshot = async (toolName: string, input: unknown): Promise<void> => {
    const toolCallId = mintToolCallId()
    const paths = safeExtractPaths(extractPaths, toolName, input, logger)
    const filesBefore =
      paths.length > 0 && readFile !== undefined
        ? await buildFilesBefore(paths, readFile, logger)
        : new Map<string, string>()
    const taskMessagesBefore = getCurrentMessages()
    const turn = getCurrentTurn()
    try {
      const result = registry.record({
        toolCallId,
        turn,
        takenAt: now(),
        filesBefore,
        taskMessagesBefore,
      })
      if (!result.ok) {
        logger?.warn(
          `per-tool-snapshot-recorder: registry.record ok:false reason=${result.reason} for ${toolName}`,
        )
      }
    } catch (e) {
      logger?.warn(
        `per-tool-snapshot-recorder: registry.record threw for ${toolName}: ${errMessage(e)}`,
      )
    }
  }

  return {
    wrapTool<I, O>(tool: Tool<I, O>): Tool<I, O> {
      const wrapped: Tool<I, O> = {
        ...tool,
        execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent> {
          const inner = tool.execute.bind(tool)
          return (async function* (): AsyncIterable<ToolEvent> {
            // Pre-execute snapshot. NO-THROW — captureSnapshot swallows every
            // failure into a warn so the tool execute is byte-identical when
            // the registry / reader hiccups.
            try {
              await captureSnapshot(tool.name, input)
            } catch (e) {
              logger?.warn(
                `per-tool-snapshot-recorder: captureSnapshot threw for ${tool.name}: ${errMessage(
                  e,
                )}`,
              )
            }
            // Delegate to the original execute — the tool sees no wrap.
            for await (const ev of inner(input, ctx)) yield ev
          })()
        },
      }
      return wrapped
    },
  }
}
