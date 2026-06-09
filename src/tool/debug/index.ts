/** W5 DAP — debugger tool family (Debug Adapter Protocol). Default-OFF
 *  (QUANTA_DEBUG_TOOLS); `debug_inspect` runs a program under a debug adapter,
 *  stops at the first breakpoint, and reports the stack + variables. */
export { DapFrameDecoder, encodeDapMessage } from "./dap-codec"
export { DapClient, type DapResponse, type DapTransport } from "./dap-client"
export {
  type DapBreakpoint,
  type Inspection,
  type InspectSpec,
  inspectViaDap,
} from "./inspect-driver"
export { type AdapterSpawnSpec, type DebugAdapterPort, defaultDebugAdapterPort } from "./port"
export { debugInspectTool, makeDebugInspectTool } from "./tool"
