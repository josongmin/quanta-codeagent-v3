/**
 * Per-tool granular checkpoint registry — barrel.
 *
 * Surface:
 *   - {@link defaultGranularRegistry} — pure in-memory `GranularRegistryPort`
 *   - All port types from `./port`
 *
 * # Default-OFF
 *
 * No code in this slice is wired into the loop. A consumer (composition
 * root, future surface hook) opts in by constructing the port via
 * `defaultGranularRegistry()` and threading it through the `AgentConfig`
 * slot or the per-tool-checkpoint adapter. Construction performs NO I/O
 * — every byte-identical legacy caller stays byte-identical.
 *
 * # Slice discipline (mirrors `conversation-checkpoint.ts`)
 *
 * Reads ONLY:
 *   - `@/llm`   (Message type)
 *   - `./port`  (sibling)
 *
 * Does NOT import:
 *   - `@/agent/dispatch`, `@/agent/loop`, `@/agent/effect-channel`
 *   - `@/storage`, `@/permission`, `@/observability`
 *   - `@/apps/*`, `@/session/*`
 *   - `node:fs`, `node:path`
 */

export { defaultGranularRegistry } from "./default-registry"
export type {
  GranularRegistryOpts,
  GranularRegistryPort,
  RecordResult,
  ToolSnapshot,
  ToolSnapshotMeta,
} from "./port"
