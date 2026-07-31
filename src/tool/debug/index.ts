/** W5 DAP — debugger tool family (Debug Adapter Protocol). Default-OFF
 *  (QUANTA_DEBUG_TOOLS); `debug_inspect` runs a program under a debug adapter,
 *  stops at the first breakpoint, and reports the stack + variables. */

export { CdpClient, type CdpResponse, type CdpTransport } from "./cdp-client"
export { type CdpInspectOptions, type CdpInspectSpec, inspectViaCdp } from "./cdp-inspect"
export { DapClient, type DapResponse, type DapTransport } from "./dap-client"
export { DapFrameDecoder, encodeDapMessage } from "./dap-codec"
export {
  type DapBreakpoint,
  type DapVariable,
  type FrameScopes,
  type Inspection,
  type InspectSpec,
  inspectViaDap,
  type ScopeVars,
} from "./inspect-driver"
export {
  type AdapterSpawnSpec,
  connectTcpTransport,
  type DebugAdapterPort,
  defaultDebugAdapterPort,
  getFreePort,
  type NodeCdpSpawnSpec,
  spawnNodeCdpInspector,
  spawnTcpDebugAdapter,
  type TcpAdapterSpawnSpec,
  type TcpConnectSpec,
} from "./port"
export { debugInspectTool, makeDebugInspectTool } from "./tool"
