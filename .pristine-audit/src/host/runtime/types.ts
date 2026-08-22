import type { SessionHost } from "@/kernel/session"
import type { CapabilityExpectation } from "@/protocol/session"

export interface RuntimeSessionConfig {
  readonly cwd?: string
  readonly model?: string
  readonly permissionMode?: string
  readonly identityMode?: string
  readonly toolProfile?: string
}

export interface RuntimeHost {
  createSessionHost(config: RuntimeSessionConfig): Promise<SessionHost>
  close?(): Promise<void>
}

export interface CreateRuntimeOptions {
  readonly host: RuntimeHost
  readonly persistence?: unknown
  readonly policy?: unknown
  readonly expectedCapabilities?: CapabilityExpectation
}
