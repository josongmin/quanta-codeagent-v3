/**
 * OTel Resource attribute auto-enrichment (ADR-0163 follow-up to ADR-0155).
 *
 * Builds a Resource attribute bag per OpenTelemetry semconv:
 *   https://opentelemetry.io/docs/specs/semconv/resource/
 *
 * ADR-0155 shipped `otlpHttpMetricSink({resourceAttrs})` whose default is just
 * `{"service.name":"quanta"}`. Production deployments need more identity
 * attributes (`service.instance.id`, `service.version`, `deployment.environment`,
 * `host.name`, `process.*`, `process.runtime.*`) so collectors can group /
 * filter / alert per-instance and per-environment.
 *
 * Posture:
 *   - **Pure**: returns a plain `Record<string,string>`. No I/O beyond
 *     `process.env` + `os.hostname()` + an OPTIONAL `readFileSync` of a sibling
 *     `package.json` for `service.version` fallback (last-resort — env var wins).
 *   - **Test seam**: `hostnameFn` / `pidFn` / `env` opts let the hellgate drive
 *     auto-detect without touching real `process.env` / `os.hostname()`.
 *   - **Opts override auto-detect**: `opts.extra` merges LAST so callers can
 *     pin any attribute.
 *   - **Plane-clean**: imports only `node:os` + `node:fs` (sync because the
 *     public API is sync per Part-1 contract — `fs/promises` is incompatible
 *     with a synchronous return). NO `@/agent`, `@/llm`, `@/tool`.
 *
 * Why we omit `service.namespace` when unset: the OTel semconv treats absence
 * as "no namespace bound" rather than "namespace = empty string"; emitting
 * `""` would create a synthetic empty-namespace dimension at the collector.
 *
 * Why we cast every value to `string`: OTel attributes accept `string | number
 * | boolean`, but the `MetricSink` adapter and `otlp-helper` Resource attrs
 * field at our layer are `Record<string,string>`. Keeping the contract narrow
 * removes ambiguity (e.g. `process.pid` is a number — we stringify).
 */

import { readFileSync } from "node:fs"
import { hostname as osHostname } from "node:os"
import { dirname, join } from "node:path"

// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

export interface ResourceAutoOpts {
  /** Logical service name. Overrides `env.QUANTA_SERVICE_NAME` and the
   *  built-in default `"quanta"`. */
  readonly serviceName?: string
  /** Version string. Overrides `env.QUANTA_VERSION` and the
   *  `package.json` fallback (`"0.0.0"` last resort). */
  readonly serviceVersion?: string
  /** Deployment environment (e.g. `"prod"`, `"staging"`). Overrides
   *  `env.QUANTA_DEPLOYMENT_ENV`; default `"unknown"`. */
  readonly deploymentEnv?: string
  /** Extra attrs that override anything auto-detected. Merged LAST. */
  readonly extra?: Readonly<Record<string, string>>
  /** Test seam — override `os.hostname()`. */
  readonly hostnameFn?: () => string
  /** Test seam — override `process.pid`. */
  readonly pidFn?: () => number
  /** Test seam — override `process.env`. The provided record is consulted
   *  exclusively (real `process.env` is NOT read when this is set). */
  readonly env?: Readonly<Record<string, string | undefined>>
}

// ────────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_SERVICE_NAME = "quanta"
const DEFAULT_DEPLOYMENT_ENV = "unknown"
const FALLBACK_VERSION = "0.0.0"

/** Best-effort sync read of a sibling package.json for `version`. Walks up to
 *  4 parents from the caller's cwd to handle nested layouts (apps/* / tests
 *  run from repo root). Returns `undefined` if not found / unparseable —
 *  callers fall back to `FALLBACK_VERSION`. */
const readPackageVersion = (): string | undefined => {
  let dir = process.cwd()
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, "package.json")
    try {
      const raw = readFileSync(candidate, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === "object" && "version" in parsed) {
        const v = (parsed as { version?: unknown }).version
        if (typeof v === "string" && v.length > 0) return v
      }
    } catch {
      // Not present at this level — continue walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Detect runtime name. `globalThis.Bun` is the documented Bun marker. */
const detectRuntimeName = (): string => {
  const bun = (globalThis as { Bun?: unknown }).Bun
  if (bun !== undefined) return "bun"
  return "node"
}

/** Detect runtime version. Prefer `process.versions.bun` if Bun is the host;
 *  fall back to `process.versions.node`. */
const detectRuntimeVersion = (): string => {
  const versions: Readonly<Record<string, string | undefined>> = process.versions
  const bun = versions.bun
  if (typeof bun === "string" && bun.length > 0) return bun
  const node = versions.node
  if (typeof node === "string" && node.length > 0) return node
  return "0.0.0"
}

// ────────────────────────────────────────────────────────────────────────────
// Public factory
// ────────────────────────────────────────────────────────────────────────────

/** Build a Resource attribute bag per OTel semconv. Pure (no async I/O); see
 *  module header for posture. The returned record is mutable but callers
 *  should treat it as read-only — pass directly to `otlpHttpMetricSink({
 *  resourceAttrs })`. */
export const buildOtelResourceAttrs = (opts?: ResourceAutoOpts): Record<string, string> => {
  const env: Readonly<Record<string, string | undefined>> = opts?.env ?? process.env
  const hostnameFn = opts?.hostnameFn ?? osHostname
  const pidFn = opts?.pidFn ?? (() => process.pid)

  const host = hostnameFn()
  const pid = pidFn()

  const serviceName = opts?.serviceName ?? env.QUANTA_SERVICE_NAME ?? DEFAULT_SERVICE_NAME
  const serviceVersion =
    opts?.serviceVersion ?? env.QUANTA_VERSION ?? readPackageVersion() ?? FALLBACK_VERSION
  const deploymentEnv = opts?.deploymentEnv ?? env.QUANTA_DEPLOYMENT_ENV ?? DEFAULT_DEPLOYMENT_ENV
  const serviceNamespace = env.QUANTA_NAMESPACE

  const out: Record<string, string> = {
    "service.name": serviceName,
    "service.instance.id": `${host}-${pid}`,
    "service.version": serviceVersion,
    "deployment.environment": deploymentEnv,
    "host.name": host,
    "process.pid": String(pid),
    "process.runtime.name": detectRuntimeName(),
    "process.runtime.version": detectRuntimeVersion(),
  }

  // service.namespace is OMITTED when env absent (no synthetic empty value).
  if (typeof serviceNamespace === "string" && serviceNamespace.length > 0) {
    out["service.namespace"] = serviceNamespace
  }

  // opts.extra merged LAST so callers can override anything auto-detected.
  if (opts?.extra !== undefined) {
    for (const k of Object.keys(opts.extra)) {
      const v = opts.extra[k]
      if (typeof v === "string") out[k] = v
    }
  }

  return out
}
