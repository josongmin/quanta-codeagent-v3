import type {
  GroundingCorpus,
  GroundingMode,
  GroundingNormalizationProfile,
  GroundingOutputProtocol,
  GroundingProbeProfile,
  GroundingSuite,
} from "./schema"

export interface GroundingExecutionConfig {
  readonly mode: GroundingMode
  readonly probeProfile: GroundingProbeProfile
  readonly normalizationProfile: GroundingNormalizationProfile
  readonly outputProtocol: GroundingOutputProtocol
}

export const resolveGroundingCorpus = (
  rawCorpus: string | undefined,
  rawSuite: string | undefined,
): GroundingCorpus => {
  if (rawCorpus === undefined || rawCorpus === "") {
    if (rawSuite === undefined || rawSuite === "") return "canary"
    if (rawSuite === "canary" || rawSuite === "nightly") return rawSuite
    throw new Error("grounding suite must be canary or nightly")
  }
  switch (rawCorpus) {
    case "canary":
    case "nightly":
    case "replay_critical":
    case "replay_nightly":
    case "adversarial_canary":
    case "adversarial_nightly":
      return rawCorpus
    default:
      throw new Error("grounding corpus must be one of canary, nightly, replay_critical, replay_nightly, adversarial_canary, adversarial_nightly")
  }
}

export const manualSuiteForCorpus = (corpus: GroundingCorpus): GroundingSuite | undefined =>
  corpus === "canary" || corpus === "nightly" ? corpus : undefined

export const resolveGroundingExecutionConfig = (mode: GroundingMode): GroundingExecutionConfig => {
  switch (mode) {
    case "raw":
      return {
        mode,
        probeProfile: "minimal",
        normalizationProfile: "none",
        outputProtocol: "exact_json",
      }
    case "engine":
      return {
        mode,
        probeProfile: "runtime_parity",
        normalizationProfile: "structural",
        outputProtocol: "exact_json",
      }
    case "assisted":
      return {
        mode,
        probeProfile: "assisted",
        normalizationProfile: "heuristic",
        outputProtocol: "exact_json",
      }
  }
}
