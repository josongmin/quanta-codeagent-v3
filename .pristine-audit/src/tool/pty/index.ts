/**
 * `@/tool/pty` — N6 PTY/tmux session attach (RFC `docs/plans/jun-4-pty-attach.md`).
 * Phase-1: the closed `PtySessionPort` + 6 gated tools, default-OFF (registered
 * only when the host wires a backend behind `QUANTA_PTY_ATTACH`).
 */

export { createBunPtyAdapter } from "./bun-pty-adapter"
export {
  type AttachResult,
  type BunPtyAdapter,
  type BunPtySpawnOpts,
  PTY_MAX_ATTACHED,
  PTY_MAX_DIM,
  PTY_MAX_WRITE_BYTES,
  PTY_MIN_DIM,
  PTY_RING_BYTES,
  type PtyBackendKind,
  type PtyChildHandle,
  type PtyChunk,
  type PtyErrorCode,
  type PtyFactoryPort,
  type PtyHandle,
  type PtyHandleInfo,
  type PtyResult,
  type PtySessionPort,
  type PtyTerminalHandle,
  type PtyWriteOpts,
  type ReadResult,
} from "./port"
export {
  createTmuxAdapter,
  type TmuxAdapterOpts,
  type TmuxExec,
} from "./tmux-adapter"
export {
  type PtyAttachInput,
  type PtyReadInput,
  type PtyResizeInput,
  type PtyWriteInput,
  ptyTools,
} from "./tools"
