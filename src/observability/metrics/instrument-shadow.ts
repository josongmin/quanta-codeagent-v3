/**
 * ShadowOdb instrumentation (ADR-0160 — extends ADR-0158 24-metric recipe).
 *
 * Counters:
 *   shadow.checkpoint.total      labels: kind (auto|manual)
 *   shadow.rewind.total          labels: target (last|verified)
 *   shadow.diff.total            labels: kind (since-last|workspace-since-last)
 *   shadow.restore_partial.total
 *   shadow.markVerified.total
 *
 * Histograms:
 *   shadow.checkpoint.duration_ms
 *   shadow.rewind.duration_ms    labels: target
 *
 * Pure forwarding wrapper — no slice-side imports of `@/observability`.
 * `safe()` swallow on metrics throws (sink no-throw + belt+suspenders).
 */

import type {
  RewindOptions,
  RewindToRefOptions,
  ShadowInitResult,
  ShadowOdb,
  SnapshotDiff,
  SnapshotMetadata,
} from "@/storage/shadow-odb"
import type { MetricsRegistry } from "./port"

const safe = (metrics: MetricsRegistry, fn: () => void): void => {
  try {
    fn()
  } catch {
    /* observability emission must not break the wrapped call */
  }
}

export interface ShadowOdbInstrumentOpts {
  /** Default prefix is "shadow". */
  readonly namePrefix?: string
  /** Default = performance.now. */
  readonly now?: () => number
  /** Default kind label for registerHead (caller can swap to "manual"). */
  readonly defaultCheckpointKind?: "auto" | "manual"
}

export const instrumentShadowOdb = (
  odb: ShadowOdb,
  metrics: MetricsRegistry,
  opts?: ShadowOdbInstrumentOpts,
): ShadowOdb => {
  const prefix = opts?.namePrefix ?? "shadow"
  const now = opts?.now ?? (() => performance.now())
  const checkpointKind = opts?.defaultCheckpointKind ?? "manual"

  const observeDuration = (name: string, t0: number, labels: Record<string, string> = {}): void => {
    safe(metrics, () => metrics.observe(name, now() - t0, labels))
  }

  return {
    async init(workspaceRoot: string): Promise<ShadowInitResult> {
      return odb.init(workspaceRoot)
    },

    async registerHead(workspaceRoot: string): Promise<string> {
      safe(metrics, () =>
        metrics.increment(`${prefix}.checkpoint.total`, 1, { kind: checkpointKind }),
      )
      const t0 = now()
      try {
        return await odb.registerHead(workspaceRoot)
      } finally {
        observeDuration(`${prefix}.checkpoint.duration_ms`, t0)
      }
    },

    async diffSinceLast(workspaceRoot: string): Promise<string> {
      safe(metrics, () => metrics.increment(`${prefix}.diff.total`, 1, { kind: "since-last" }))
      return odb.diffSinceLast(workspaceRoot)
    },

    async diffWorkspaceSinceLast(anchor: string, comparison: string): Promise<string> {
      safe(metrics, () =>
        metrics.increment(`${prefix}.diff.total`, 1, { kind: "workspace-since-last" }),
      )
      return odb.diffWorkspaceSinceLast(anchor, comparison)
    },

    async rewindToLast(workspaceRoot: string, rewindOpts?: RewindOptions): Promise<void> {
      safe(metrics, () => metrics.increment(`${prefix}.rewind.total`, 1, { target: "last" }))
      const t0 = now()
      try {
        await odb.rewindToLast(workspaceRoot, rewindOpts)
      } finally {
        observeDuration(`${prefix}.rewind.duration_ms`, t0, { target: "last" })
      }
    },

    async rewindToVerified(workspaceRoot: string, rewindOpts?: RewindOptions): Promise<void> {
      safe(metrics, () => metrics.increment(`${prefix}.rewind.total`, 1, { target: "verified" }))
      const t0 = now()
      try {
        await odb.rewindToVerified(workspaceRoot, rewindOpts)
      } finally {
        observeDuration(`${prefix}.rewind.duration_ms`, t0, { target: "verified" })
      }
    },

    async restorePartial(
      workspaceRoot: string,
      paths: ReadonlyArray<string>,
      rewindOpts?: RewindOptions,
    ): Promise<void> {
      safe(metrics, () => metrics.increment(`${prefix}.restore_partial.total`))
      return odb.restorePartial(workspaceRoot, paths, rewindOpts)
    },

    async markVerified(workspaceRoot: string): Promise<void> {
      safe(metrics, () => metrics.increment(`${prefix}.markVerified.total`))
      return odb.markVerified(workspaceRoot)
    },

    async listSnapshots(workspaceRoot: string): Promise<readonly SnapshotMetadata[]> {
      return odb.listSnapshots(workspaceRoot)
    },

    async rewindToRef(
      workspaceRoot: string,
      ordinal: number,
      refOpts?: RewindToRefOptions,
    ): Promise<SnapshotMetadata> {
      safe(metrics, () => metrics.increment(`${prefix}.rewind.total`, 1, { target: "ordinal" }))
      const t0 = now()
      try {
        return await odb.rewindToRef(workspaceRoot, ordinal, refOpts)
      } finally {
        observeDuration(`${prefix}.rewind.duration_ms`, t0, { target: "ordinal" })
      }
    },

    async restorePartialFromRef(
      workspaceRoot: string,
      ordinal: number,
      paths: ReadonlyArray<string>,
      refOpts?: RewindToRefOptions,
    ): Promise<SnapshotMetadata> {
      safe(metrics, () => metrics.increment(`${prefix}.restore_partial.total`))
      return odb.restorePartialFromRef(workspaceRoot, ordinal, paths, refOpts)
    },

    async diffSinceRef(workspaceRoot: string, ordinal: number): Promise<SnapshotDiff> {
      safe(metrics, () => metrics.increment(`${prefix}.diff.total`, 1, { kind: "since-ref" }))
      return odb.diffSinceRef(workspaceRoot, ordinal)
    },

    async cleanup(maxBytes: number): Promise<number> {
      return odb.cleanup(maxBytes)
    },
  }
}
