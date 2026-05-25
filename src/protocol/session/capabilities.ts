export interface CapabilityManifest {
  readonly approvals: "none" | "operator"
  readonly tools: boolean
  readonly memory: boolean
  readonly artifacts: boolean
  readonly subagents: boolean
  readonly automation: boolean
  readonly shellSnapshot: boolean
  readonly transport: "inproc" | "stdio" | "websocket"
}

export type CapabilityExpectation = Partial<CapabilityManifest>

export const normalizeCapabilityManifest = (
  manifest: Partial<CapabilityManifest> | undefined,
): CapabilityManifest => ({
  approvals: manifest?.approvals ?? "none",
  tools: manifest?.tools ?? false,
  memory: manifest?.memory ?? false,
  artifacts: manifest?.artifacts ?? false,
  subagents: manifest?.subagents ?? false,
  automation: manifest?.automation ?? false,
  shellSnapshot: manifest?.shellSnapshot ?? false,
  transport: manifest?.transport ?? "inproc",
})
