import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import type {
  SessionBootstrapDeps,
  SessionBootstrapResult,
  SessionRuntimeConfigShape,
} from "@/host/bootstrap"
import { bootstrapSession } from "@/host/bootstrap"
import {
  defaultResponsesContinuationStore,
  type ResponsesContinuationStore,
} from "@/llm/responses-continuation-store"
import type { RuntimeContext, RuntimeFacade, RuntimeSession } from "@/sdk/runtime"
import {
  attachSessionTransport,
  createRuntimeFromBootstrap,
  summarizeRuntimeContext,
} from "@/sdk/runtime"
import { buildHeadlessApprovalWiring } from "./approval-wiring"
import type { RecordingStream } from "./fake-deps"
import type { HeadlessRunInput, HeadlessRuntimeWires } from "./types"

type HeadlessRuntimeContext = Awaited<
  ReturnType<typeof createRuntimeFromBootstrap>
>["runtimeContext"]

interface OpenHeadlessRuntimeSessionArgs {
  readonly input: HeadlessRunInput
  readonly deps: SessionBootstrapDeps
  readonly runtime: SessionRuntimeConfigShape
  readonly stream: RecordingStream
}

export interface HeadlessSessionBridge {
  readonly boot: SessionBootstrapResult
  readonly runtimeContext: RuntimeContext
  readonly runtimeFacade: RuntimeFacade
  readonly session: RuntimeSession
  readonly transportHandle?: Awaited<ReturnType<typeof attachSessionTransport>>
}

const buildHeadlessRuntimeArgs = (
  boot: SessionBootstrapResult,
  input: HeadlessRunInput,
  stream: RecordingStream,
  convStore: ReturnType<typeof defaultConversationCheckpointStore>,
  responsesStore: ResponsesContinuationStore,
): Parameters<typeof createRuntimeFromBootstrap>[0] => {
  // ADR-0540 W1-A — QUANTA_INLINE_APPROVAL_RESOLVER ON ⇒ an inline auto-approve
  // surface resolves a mid-turn ask in the SAME turn (no deferred throw + turn
  // re-run). OFF ⇒ deny + no `approvalProtocol` ⇒ byte-identical to the pre-W1
  // deferred composition (the `driveSessionTurn` `resolveApproval` re-run path).
  const approval = buildHeadlessApprovalWiring(input.env ?? {})
  // jul-16 GAP-3 (02 serve --stdio) — assemble the overlay from the approval
  // wiring PLUS the composition-declared wire transport stamp. Both slots are
  // presence-only: absent ⇒ the overlay key is omitted (byte-identical to the
  // pre-seam composition, `capabilities.transport` falls back to `"inproc"`).
  const overlay = {
    ...(approval.approvalProtocol !== undefined
      ? { approvalProtocol: approval.approvalProtocol }
      : {}),
    ...(input.sessionTransport !== undefined
      ? { sessionTransport: input.sessionTransport }
      : {}),
  }
  return {
    boot,
    stream,
    onConfirm: approval.onConfirm,
    ...(Object.keys(overlay).length > 0 ? { overlay } : {}),
    execution: {
      history: boot.history,
      cwd: boot.cwd,
      convStore,
      envSource: input.env ?? {},
      responsesStore,
    },
    memoryAuto: {
      env: input.env ?? {},
      homeDir: input.homeDir ?? "/tmp",
    },
    history: [...boot.history],
    state: boot.features.state,
    idMeta: boot.idMeta,
    shutdown: boot.shutdownMcp,
  }
}

const buildHeadlessSessionConfig = (
  boot: SessionBootstrapResult,
): Parameters<RuntimeFacade["createSession"]>[0] => ({
  cwd: boot.cwd,
  model: boot.model,
  permissionMode: boot.mode,
  ...(boot.identityModeState !== undefined ? { identityMode: boot.identityModeState.get() } : {}),
  ...(boot.toolProfileState !== undefined ? { toolProfile: boot.toolProfileState.get() } : {}),
})

export const summarizeHeadlessSessionWires = (
  runtimeContext: HeadlessRuntimeContext,
): HeadlessRuntimeWires => summarizeRuntimeContext(runtimeContext)

export const openHeadlessRuntimeSession = async (
  args: OpenHeadlessRuntimeSessionArgs,
): Promise<HeadlessSessionBridge> => {
  const boot = await bootstrapSession(args.deps, args.runtime, {})
  const convStore = defaultConversationCheckpointStore()
  const responsesStore = defaultResponsesContinuationStore()

  if (args.input.signal) {
    if (args.input.signal.aborted) boot.abort.abort()
    else args.input.signal.addEventListener("abort", () => boot.abort.abort(), { once: true })
  }

  const { runtime, runtimeContext } = await createRuntimeFromBootstrap(
    buildHeadlessRuntimeArgs(boot, args.input, args.stream, convStore, responsesStore),
  )
  const session = await runtime.createSession(buildHeadlessSessionConfig(boot))
  const transportHandle =
    args.input.transport === undefined
      ? undefined
      : await attachSessionTransport({
          session,
          transport: args.input.transport,
          ...(args.input.transportReplayWindow !== undefined
            ? { replayWindow: args.input.transportReplayWindow }
            : {}),
        })

  return {
    boot,
    runtimeContext,
    runtimeFacade: runtime,
    session,
    ...(transportHandle !== undefined ? { transportHandle } : {}),
  }
}
