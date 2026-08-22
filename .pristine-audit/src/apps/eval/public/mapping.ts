/**
 * Public benchmark → UseCaseId mapping.
 *
 * Each entry says: "results from bench X are evidence for use case Y." A bench
 * may map to multiple leaves (SWE-bench mostly Debugging, partially
 * Refactoring/Issue Resolution). The mapping is descriptive only; storage
 * records persist the FIRST mapped use case as `usecase` and report the
 * remainder via the `note` field.
 */
import type { UseCaseId } from "../types"

export interface BenchMapping {
  /** Adapter name (e.g. `swebench-verified`). */
  bench: string
  /** Primary use case for store keying. */
  primary: UseCaseId
  /** Additional leaves this bench evidences. */
  secondary?: readonly UseCaseId[]
  note?: string
}

export const MAPPINGS: readonly BenchMapping[] = [
  {
    bench: "swebench-verified",
    primary: "software-quality.debugging.error-message-paste",
    secondary: [
      "software-quality.issue-resolution.github-issue",
      "software-quality.debugging.reproducer",
      "software-quality.testing.unit-gen",
    ],
    note: "Real GitHub issue → patch. Multi-leaf evidence; primary is Debugging.",
  },
  {
    bench: "livecodebench",
    primary: "feature-implementation.new-feature.spec-to-impl",
    note: "Algorithmic spec → solution; uncontaminated by training cutoff.",
  },
  {
    bench: "terminalbench",
    primary: "operational.deploy.deploy-cmd",
    secondary: ["feature-implementation.scripting.automation"],
    note: "Long-horizon shell tasks; touches Deploy + Scripting.",
  },
  {
    bench: "multi-swebench",
    primary: "feature-implementation.migration.language",
    secondary: ["software-quality.debugging.error-message-paste"],
    note: "Multi-language SWE-bench variants; emphasises Migration.",
  },
]

export const findMapping = (bench: string): BenchMapping | undefined =>
  MAPPINGS.find((m) => m.bench === bench)
