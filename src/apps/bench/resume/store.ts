/**
 * Bench-resume STORE factory — thin wiring that composes the durable layers for
 * one resume key:
 *
 *   s3Backend(bucket/region)  →  segmentStore(backend, key)  →  s3ReplayStore({store})
 *
 * The cassette is the segment log; the receipt helpers bind this layer's
 * `writeReceipt`/`readReceipt` to `(backend, key)` so callers never repeat the
 * key. NO policy lives here (DEFAULT-OFF / activation is `config.ts`); this is
 * pure composition so the producer + consumer agents share one wiring point.
 */
import { s3ReplayStore } from "@/llm/replay"
import type { ReplayStore } from "@/llm/replay"
import {
  type RemoteBackend,
  readReceipt,
  type ResumeReceipt,
  type S3BackendOptions,
  s3Backend,
  type SegmentStore,
  segmentStore,
  writeReceipt,
} from "@/shared/remote-store"

export interface ResumeStoreConfig {
  readonly bucket: string
  readonly region?: string
  /** Injected aws cli runner (offline-testable); default = the real cli. */
  readonly runAws?: S3BackendOptions["runAws"]
}

export interface ResumeStore {
  readonly backend: RemoteBackend
  readonly segments: SegmentStore
  readonly replayStore: ReplayStore
  writeReceipt(r: ResumeReceipt): Promise<void>
  readReceipt(): Promise<ResumeReceipt | undefined>
}

export const resumeStore = (cfg: ResumeStoreConfig, key: string): ResumeStore => {
  // exactOptionalPropertyTypes: pass region/runAws only when present so the
  // shape matches `S3BackendOptions`'s optional fields (no explicit undefined).
  const backend = s3Backend({
    bucket: cfg.bucket,
    ...(cfg.region !== undefined ? { region: cfg.region } : {}),
    ...(cfg.runAws !== undefined ? { runAws: cfg.runAws } : {}),
  })
  const segments = segmentStore(backend, key)
  const replayStore = s3ReplayStore({ store: segments })
  return {
    backend,
    segments,
    replayStore,
    writeReceipt: (r) => writeReceipt(backend, key, r),
    readReceipt: () => readReceipt(backend, key),
  }
}
