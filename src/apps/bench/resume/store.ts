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

import type { MatchPolicy, ReplayStore } from "@/llm/replay"
import { s3ReplayStore } from "@/llm/replay"
import type { StreamInput } from "@/llm/types"
import {
  makeDefaultRunAws,
  type RemoteBackend,
  type ResumeReceipt,
  type ResumeSecurityReceipt,
  readReceipt,
  type S3BackendOptions,
  type SegmentStore,
  s3Backend,
  segmentStore,
  writeReceipt,
} from "@/shared/remote-store"
import { attestedBackend, attestResumeSecurity } from "./security"

export interface ResumeStoreConfig {
  readonly bucket: string
  readonly region?: string
  /** Injected aws cli runner (offline-testable); default = the real cli. */
  readonly runAws?: S3BackendOptions["runAws"]
  /**
   * Override the request→hash used by the durable S3 replay store. The resume
   * path passes the CANONICALIZING `resumeHashRequest` here so a cassette
   * recorded on box A replays HIT on box B (volatile tokens masked before
   * hashing). Absent ⇒ the store's `defaultHashRequest` (byte-identical match
   * with the jsonl store — used by tests / non-resume callers).
   */
  readonly hashRequest?: (req: StreamInput, policy: MatchPolicy) => string
  /** Omit only for isolated low-level tests. Production resume always supplies it. */
  readonly security?: {
    readonly kmsKeyArn: string
    readonly principalArn: string
    readonly maxRetentionDays: number
  }
}

export interface ResumeStore {
  readonly backend: RemoteBackend
  readonly segments: SegmentStore
  readonly replayStore: ReplayStore
  writeReceipt(r: ResumeReceipt): Promise<void>
  readReceipt(): Promise<ResumeReceipt | undefined>
  securityReceipt(): Promise<ResumeSecurityReceipt | undefined>
}

export const resumeStore = (cfg: ResumeStoreConfig, key: string): ResumeStore => {
  // exactOptionalPropertyTypes: pass region/runAws only when present so the
  // shape matches `S3BackendOptions`'s optional fields (no explicit undefined).
  const runAws = cfg.runAws ?? makeDefaultRunAws(60_000)
  const rawBackend = s3Backend({
    bucket: cfg.bucket,
    ...(cfg.region !== undefined ? { region: cfg.region } : {}),
    runAws,
    ...(cfg.security !== undefined ? { sse: "aws:kms", sseKmsKeyId: cfg.security.kmsKeyArn } : {}),
  })
  let securityPromise: Promise<ResumeSecurityReceipt> | undefined
  const ensureSecurity = (): Promise<ResumeSecurityReceipt> => {
    if (cfg.security === undefined) {
      return Promise.reject(new Error("resume security configuration is required"))
    }
    securityPromise ??= attestResumeSecurity(
      {
        bucket: cfg.bucket,
        keyPrefix: key,
        kmsKeyArn: cfg.security.kmsKeyArn,
        principalArn: cfg.security.principalArn,
        maxRetentionDays: cfg.security.maxRetentionDays,
        ...(cfg.region !== undefined ? { region: cfg.region } : {}),
      },
      runAws,
    )
    return securityPromise
  }
  const backend =
    cfg.security !== undefined ? attestedBackend(rawBackend, ensureSecurity) : rawBackend
  const segments = segmentStore(backend, key)
  const replayStore = s3ReplayStore({
    store: segments,
    ...(cfg.hashRequest !== undefined ? { hashRequest: cfg.hashRequest } : {}),
  })
  return {
    backend,
    segments,
    replayStore,
    writeReceipt: (r) => writeReceipt(backend, key, r),
    readReceipt: () => readReceipt(backend, key),
    securityReceipt: () =>
      cfg.security !== undefined ? ensureSecurity() : Promise.resolve(undefined),
  }
}
