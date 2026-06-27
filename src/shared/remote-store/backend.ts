/**
 * Provider-agnostic durable object store — the GENERAL reuse layer behind bench
 * spot-resume, but coupled to NEITHER bench NOR LLM-replay. Any consumer that
 * needs to persist opaque bytes off-host and read them back (agent-session
 * checkpoints, trace spans, artifacts) depends on this interface; the concrete
 * backend (S3 via the `aws` CLI today; gcs/local later) is injected.
 *
 * Contract (every impl MUST honor):
 *   - `put` is last-writer-wins for a path; overwriting is allowed.
 *   - `get` returns `undefined` for a missing key — NEVER throws on not-found
 *     (callers branch on presence; a throw is reserved for transport failure).
 *   - `list` returns the FULL keys (not basenames) under `prefix`, in no
 *     guaranteed order — callers sort if they need ordering.
 */
export interface RemoteBackend {
  put(path: string, body: string): Promise<void>
  get(path: string): Promise<string | undefined>
  list(prefix: string): Promise<readonly string[]>
}
