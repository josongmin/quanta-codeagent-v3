/**
 * `@/apps/terminal` — the `terminal` ToolSurface composition root (TB21-06 TC-1/TC-1a, spec S2/S3 —
 * `docs/plans/aug-21-bench-terminal-2-1/TB21-06-transferred-contracts.md`).
 *
 * The BRAIN-side entry-point that ASSEMBLES the terminal surface: the BASE-free
 * {@link buildTerminalTools} registry (`container_exec` + `pty_*` — both default-ON on this surface,
 * never the BASE repo-edit/host-exec set) plus the operator capability guide, wired to injected
 * container / pty backends. The box phase (the Python `QuantaAgent` adapter under
 * `adapters/terminal-bench`) drives a quanta brain that calls {@link terminalSurfaceOverDuplex} to
 * obtain its tools + guide, then runs the agent loop; a separate HANDS process (serve.py) actually
 * runs the `container_exec` frames inside the bound container.
 *
 * Backend-agnostic BY CONSTRUCTION: this root sees only the `ContainerExec` / `PtySessionPort`
 * ports (a JSON-line duplex to a hands process, or — later — a docker-exec backend). NO
 * orchestrator / Harbor / Docker specifics leak here (upholds the TC-1 ownership-boundary naming invariant), and
 * there is NO host-execution path on this surface (spec S3: host bash is never registered).
 *
 * This module is the SINGLE production caller of {@link buildTerminalTools},
 * {@link terminalOperatorGuide}, and (via {@link terminalSurfaceOverDuplex}) `containerExecOverIpc`.
 */
import { buildTerminalTools, terminalOperatorGuide } from "@/tool"
import {
  type ContainerExec,
  containerExecOverIpc,
  type JsonLineDuplex,
} from "@/tool/container-exec"
import type { PtySessionPort } from "@/tool/pty"

/** Already-built backend ports for the terminal surface. Each port is independent: an absent port
 *  simply omits its tool family (fail-safe — the surface NEVER falls back to the BASE set). */
export interface TerminalSurfaceDeps {
  /** One-shot container exec backend (the workhorse). Absent ⇒ `container_exec` tool not minted. */
  containerExec?: ContainerExec
  /** B2 (RFC jul-3): exact-byte file-authoring backend (usually the SAME `ContainerExec`
   *  instance). Absent ⇒ `container_write_file` not minted (default-OFF; the entry point wires it
   *  only when `QUANTA_TB_WRITE_TOOL` is on). */
  containerWriteFile?: ContainerExec
  /** Interactive PTY / tmux backend. Absent ⇒ the `pty_*` tools are not minted. */
  ptySession?: PtySessionPort
}

export interface TerminalSurface {
  /** The BASE-free terminal tool registry (`container_exec` + `pty_*`, per the wired ports). */
  tools: ReturnType<typeof buildTerminalTools>
  /** Operator capability guidance injected alongside the tools (TB21-06 TC-3 — closes the
   *  exe-not-in-PATH failure). General operator habits, NO answer-key. */
  operatorGuide: string
}

/** Assemble the terminal surface from already-built backend ports. */
export const assembleTerminalSurface = (deps: TerminalSurfaceDeps = {}): TerminalSurface => ({
  tools: buildTerminalTools({
    ...(deps.containerExec !== undefined ? { containerExec: deps.containerExec } : {}),
    ...(deps.containerWriteFile !== undefined
      ? { containerWriteFile: deps.containerWriteFile }
      : {}),
    ...(deps.ptySession !== undefined ? { ptySession: deps.ptySession } : {}),
  }),
  operatorGuide: terminalOperatorGuide(),
})

/** Assemble the terminal surface with its `container_exec` backed by a JSON-line duplex to the
 *  hands process — the box-phase wiring (`containerExecOverIpc` over the brain↔hands stdio). The
 *  `ptySession` stays INJECTED (a tmux backend bound to the same container) so this root never
 *  reaches for one itself. `opts.writeFile` (B2, default false) additionally mints
 *  `container_write_file` over the SAME bridge instance (one duplex, one id-space — a second
 *  `containerExecOverIpc` would fork the id counter and cross frames). */
export const terminalSurfaceOverDuplex = (
  duplex: JsonLineDuplex,
  ptySession?: PtySessionPort,
  opts?: { writeFile?: boolean },
): TerminalSurface => {
  const exec = containerExecOverIpc(duplex)
  return assembleTerminalSurface({
    containerExec: exec,
    ...(opts?.writeFile === true ? { containerWriteFile: exec } : {}),
    ...(ptySession !== undefined ? { ptySession } : {}),
  })
}
