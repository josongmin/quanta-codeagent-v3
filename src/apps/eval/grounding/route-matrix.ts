import type { GroundingCorpus, GroundingMode } from "./schema"

export interface GroundingRouteMatrixCell {
  readonly id: string
  readonly mode: GroundingMode
  readonly corpus: GroundingCorpus
  readonly provider?: string
  readonly surfaceId?: string
  readonly transportId?: string
  readonly authMode?: string
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
        surfaceId: "openai-responses",
        transportId: "public",
      },
      {
        id: "engine-openai-responses-public",
        mode: "engine",
        corpus: "canary",
        provider: "openai",
        surfaceId: "openai-responses",
        transportId: "public",
      },
    ],
  },
} as const satisfies Record<string, GroundingRouteMatrix>

export type GroundingRouteMatrixName = keyof typeof GROUNDING_ROUTE_MATRICES

export const isGroundingRouteMatrixName = (value: string): value is GroundingRouteMatrixName =>
  value in GROUNDING_ROUTE_MATRICES
