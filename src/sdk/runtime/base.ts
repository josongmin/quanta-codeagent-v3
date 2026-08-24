import type { AgentConfig } from "@/agent"
import type { Message } from "@/llm"

export interface RuntimeAgentConfigAugments {
  systemSource?: unknown
  followUpQueue?: unknown
  planStore?: unknown
  searchPipeline?: unknown
  memoryConsolidator?: unknown
  sessionCtx?: unknown
  delegation?: unknown
  subagentBackground?: unknown
  autoBackground?: unknown
  fork?: unknown
  forkSession?: unknown
  conversationCheckpoint?: unknown
  stage1OutputsStore?: unknown
  automationEngine?: unknown
  /** S1 (jul-04) `/browser-net` — surface-owned net-capture sink threaded DOWN
   *  from the CLI compose seam onto the per-turn base, read duck-typed by
   *  `maybeWireBrowser`. Typed `unknown` at this SDK layer (the tool slice is not
   *  importable here). Absent ⇒ no mirror (byte-identical). */
  browserNet?: unknown
  /** `/goal` (Codex parity) — surface-owned objective store threaded DOWN from
   *  the CLI compose seam so the LLM `objective_*` tools mutate the SAME store
   *  the `/goal` slash + idle continuation ticker read (agent can mark the goal
   *  complete ⇒ pursuit auto-stops). Duck-typed `unknown` here; `maybeWireObjective`
   *  preserves it (caller-override). Absent ⇒ assembler mints its own. */
  objective?: unknown
  /** RFC-05 E4 — the surface-owned posture FRONT-DOOR control (`@/permission/
   *  posture/control` `PostureControl`) threaded DOWN from the composition root so
   *  the host `setPosture` projection and the CLI `/posture` selector mutate the
   *  SAME live posture authority (a change here reaches the next turn's gate).
   *  Duck-typed `unknown` at this SDK layer (the `@/permission` slice is not
   *  importable here). Absent ⇒ the host's `setPosture` falls back to the
   *  mode-only compat write (the E3 `permission.mode` adapter), byte-identical for
   *  a runtime without a wired posture control. */
  postureControl?: unknown
  /** RFC-06 F5 — the surface-owned SHARED F1 skill runtime authority
   *  (`@/skill` `SkillRuntimeAuthority`) threaded DOWN from the composition root
   *  so the host `setSkillEnabled` projection (the `session.skill.set_enabled`
   *  front door) and the CLI `/skill` actions mutate the SAME live authority the
   *  per-turn prompt/search/invocation read (a disable here reaches the next
   *  turn). Duck-typed `unknown` at this SDK layer (the `@/skill` slice is not
   *  importable here). Absent ⇒ the host omits `setSkillEnabled` ⇒ the scheduler
   *  raises the typed unsupported negative (byte-identical for a runtime without
   *  a wired authority). */
  skillRuntimeAuthority?: unknown
  admissibility?: unknown
  planExitPort?: unknown
  userInputPort?: unknown
  /** RFC-01 A4 — surface-owned pending-question authority (`@/session/user-question`
   *  broker) threaded DOWN from the composition root ONLY under
   *  `QUANTA_ATTENTION_NAV`. Duck-typed `unknown` at this SDK layer; the per-turn
   *  assembler passes it onto `AgentConfig.questionBroker` so the A3 dispatch
   *  producer routes `request_user_input` through it. Absent ⇒ slot omitted
   *  (byte-identical: the legacy `userInputPort` is used verbatim). */
  questionBroker?: unknown
  toolProfileState?: unknown
  identityModeState?: unknown
  focusChain?: unknown
  shellSnapshot?: unknown
  sessionEffort?: unknown
  decisionEmitter?: unknown
  /** Track A2 — composition-root named-permission-profile wire. When the
   *  operator selects a profile via `QUANTA_PERMISSION_PROFILE` / the
   *  `--permission-profile <name>` flag, the composition root constructs a
   *  `TwoLayerManager`, applies the resolved profile via
   *  `setPermissionProfileByName(threadId, name)`, and publishes the manager
   *  here so a future loop consumer can read the per-thread layered policy.
   *  Absent ⇒ slot omitted (byte-identical legacy). */
  permissionProfileManager?: unknown
  /** A2 — the SHARED per-session Canvas artifact registry, lifted onto the base
   *  by the composition root ONLY when `QUANTA_ARTIFACT_STORE` is on. Typed
   *  `unknown` at this SDK layer (the `@/artifact` slice is not importable here);
   *  the host-runtime `RuntimeBase` re-declares it as the concrete
   *  `ArtifactRegistry`. Two consumers: the capability manifest's `artifacts` bit
   *  and the turn runner's `artifact.ready` producer drain. Absent ⇒ both off
   *  (byte-identical default-OFF). */
  artifactRegistry?: unknown
  /** A2 — the host-side READ-ONLY `quanta-artifact://` preview resolver, minted
   *  at the composition root over the SAME shared registry when the store is on.
   *  Typed `unknown` at this SDK layer; the host-runtime `RuntimeBase` re-declares
   *  it as `ArtifactPreviewResolver`. A future IPC handler reads it off the base to
   *  serve jailed preview bytes. Absent ⇒ no preview channel (byte-identical). */
  artifactPreviewResolver?: unknown
  /** ADR-0540 W1-B — composition-root declaration that THIS surface's daemon
   *  owns the post-approval continuation (it re-issues `turn.run` server-side
   *  after an `approve`). Read by `buildCapabilityManifest` to stamp the
   *  `serverAutoContinues` capability marker clients gate their re-issue on.
   *  Set ONLY by the web-daemon composition under
   *  `QUANTA_INLINE_APPROVAL_RESOLVER`; absent ⇒ marker false (byte-identical
   *  on every other surface). */
  serverAutoContinues?: boolean
  /** jul-16 GAP-3 (02 serve --stdio) — composition-root declaration of THIS
   *  surface's wire transport, stamped onto `capabilities.transport`. Same
   *  presence-only seam as {@link serverAutoContinues}: the comp root sets
   *  `"stdio"` (connect stdio door) / `"websocket"` (web daemon); absent ⇒
   *  `buildCapabilityManifest` falls back to the `"inproc"` default (an
   *  in-process embedder), byte-identical to the pre-seam hardcode. Typed
   *  `"inproc" | "stdio" | "websocket"` — the `CapabilityManifest.transport`
   *  union. */
  sessionTransport?: "inproc" | "stdio" | "websocket"
}

export type RuntimeAgentConfigBase = Omit<AgentConfig, "modePolicy" | "budgetMeter"> &
  RuntimeAgentConfigAugments

export type RuntimeAgentTurnDeps = RuntimeAgentConfigBase

export type RuntimeAgentTurnAssembler = {
  bivarianceHack(messages: Message[], deps: RuntimeAgentTurnDeps): AgentConfig
}["bivarianceHack"]
