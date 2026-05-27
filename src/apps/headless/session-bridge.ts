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
): Parameters<typeof createRuntimeFromBootstrap>[0] => ({
  boot,
  stream,
  onConfirm: async () => false,
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
})

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
