import type { GroundingExecutionConfig } from "./config"
import type { GroundingCorpus, GroundingMode } from "./schema"

export interface GroundingRouteMatrixCell {
  readonly id: string
  readonly mode: GroundingMode
  readonly corpus: GroundingCorpus
  readonly provider?: string
  readonly model?: string
  readonly surfaceId?: string
  readonly transportId?: string
  readonly authMode?: string
  readonly probeProfile?: GroundingExecutionConfig["probeProfile"]
  readonly normalizationProfile?: GroundingExecutionConfig["normalizationProfile"]
  readonly structuredOutputProtocol?: GroundingExecutionConfig["outputProtocol"]
}

export interface GroundingRouteMatrix {
  readonly name: string
  readonly cells: readonly GroundingRouteMatrixCell[]
}

export const GROUNDING_ROUTE_MATRICES = {
  "primary-openai": {
    name: "primary-openai",
    cells: [
      {
        id: "raw-openai-responses-public",
        mode: "raw",
        corpus: "canary",
        provider: "openai",
        model: "gpt-4.1",
        surfaceId: "openai-responses",
        transportId: "public",
        probeProfile: "minimal",
        normalizationProfile: "none",
        structuredOutputProtocol: "exact_json",
      },
      {
        id: "engine-openai-responses-public",
        mode: "engine",
        corpus: "canary",
        provider: "openai",
        model: "gpt-4.1",
        surfaceId: "openai-responses",
        transportId: "public",
        probeProfile: "runtime_parity",
        normalizationProfile: "structural",
        structuredOutputProtocol: "exact_json",
      },
    ],
  },
} as const satisfies Record<string, GroundingRouteMatrix>

export type GroundingRouteMatrixName = keyof typeof GROUNDING_ROUTE_MATRICES

export const isGroundingRouteMatrixName = (value: string): value is GroundingRouteMatrixName =>
  value in GROUNDING_ROUTE_MATRICES
