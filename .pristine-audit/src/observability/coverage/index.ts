/**
 * Coverage observability barrel (ADR-0165).
 *
 * Re-exports the typed port + V8 adapter + reporter. Surfaces import from
 * `@/observability/coverage`; the parent `@/observability` barrel
 * intentionally does NOT pull this in (Default-OFF — surfaces opt-in by
 * importing the sub-barrel explicitly).
 */

export { type AstCoverageSourceOpts, astCoverageSource } from "./ast-source"
export { type C8SourceOpts, c8CoverageSource } from "./c8-source"
export {
  type IstanbulBranchEntry,
  type IstanbulCoverageJson,
  type IstanbulFileEntry,
  type IstanbulFnEntry,
  type IstanbulPosition,
  type IstanbulRange,
  toIstanbulJson,
} from "./istanbul-shape-emitter"
export {
  type BranchKind,
  type BranchSite,
  type IstanbulCoverageSourceExt,
  type IstanbulCoverageSourceOpts,
  istanbulCoverageSource,
  type PerBranchSidecar,
} from "./istanbul-source"
export { mergeCoverageReports } from "./merge"
export {
  CoverageError,
  type CoverageErrorCode,
  type CoverageReport,
  type CoverageSource,
  type CoverageThreshold,
  type CoverageVerdict,
  type FileCoverage,
} from "./port"
export {
  type CoverageReporter,
  defaultCoverageReporter,
  type ReporterOpts,
} from "./reporter"
export { defaultV8CoverageSource } from "./v8-source"
