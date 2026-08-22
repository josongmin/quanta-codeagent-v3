export interface CapabilityManifest {
  readonly approvals: "none" | "operator"
  readonly tools: boolean
  readonly memory: boolean
  readonly artifacts: boolean
  readonly subagents: boolean
  readonly automation: boolean
  readonly shellSnapshot: boolean
  readonly transport: "inproc" | "stdio" | "websocket"
  /** ADR-0540 W1-B (`server-auto-continues` marker) — TRUE iff the SERVER owns
   *  the post-approval continuation: after an `approval.respond` resolves with
   *  `approve`, the daemon re-issues the bare `turn.run` itself. Client
   *  contract: marker true ⇒ SKIP the client-side re-issue (browser
   *  `shouldContinueAfterApproval` / attach-client / future SDK wire clients);
   *  a non-marker-aware client's duplicate `turn.run` is neutralized
   *  server-side (dispatch-tail FIFO + the kernel's `empty_turn_input` guard).
   *  Additive: absent on the wire normalizes to `false` (legacy client-owned
   *  continuation, byte-identical). */
  readonly serverAutoContinues: boolean
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
  serverAutoContinues: manifest?.serverAutoContinues ?? false,
})
