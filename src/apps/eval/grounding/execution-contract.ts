import { type GroundingExecutionConfig } from "./config"
import type { GroundingCorpus, GroundingMode } from "./schema"
import { shortHash, stableJson } from "./stable-json"

export interface GroundingExecutionRoute {
  readonly provider?: string
  readonly model?: string
  readonly surfaceId?: string
  readonly transportId?: string
  readonly authMode?: string
}

export interface GroundingExecutionContract extends GroundingExecutionRoute {
  readonly mode: GroundingMode
  readonly corpus: GroundingCorpus
  readonly probeProfile: GroundingExecutionConfig["probeProfile"]
  readonly normalizationProfile: GroundingExecutionConfig["normalizationProfile"]
  readonly structuredOutputProtocol: GroundingExecutionConfig["outputProtocol"]
}

export const buildGroundingExecutionContract = (
  route: GroundingExecutionRoute,
  execConfig: GroundingExecutionConfig,
  corpus: GroundingCorpus,
): GroundingExecutionContract => ({
  mode: execConfig.mode,
  corpus,
  probeProfile: execConfig.probeProfile,
  normalizationProfile: execConfig.normalizationProfile,
  structuredOutputProtocol: execConfig.outputProtocol,
  ...(route.provider !== undefined ? { provider: route.provider } : {}),
  ...(route.model !== undefined ? { model: route.model } : {}),
  ...(route.surfaceId !== undefined ? { surfaceId: route.surfaceId } : {}),
  ...(route.transportId !== undefined ? { transportId: route.transportId } : {}),
  ...(route.authMode !== undefined ? { authMode: route.authMode } : {}),
})

export const groundingExecutionContractFingerprint = (
  contract: GroundingExecutionContract,
): string => shortHash(stableJson(contract))
