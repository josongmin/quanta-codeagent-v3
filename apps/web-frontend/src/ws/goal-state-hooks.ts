import { useEffect, useState } from "react"
import type { GoalReadoutData, GoalStateMessage } from "../types/protocol.readout.generated"

export interface GoalStateSource {
  subscribe(handler: (message: GoalStateMessage) => void): () => void
}

export const useGoalState = (source: GoalStateSource): GoalReadoutData | null => {
  const [state, setState] = useState<GoalReadoutData | null>(null)
  useEffect(() => source.subscribe((message) => setState(message.state)), [source])
  return state
}
