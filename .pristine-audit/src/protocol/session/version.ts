export const SESSION_PROTOCOL_VERSION = "session.v1" as const

export type SessionProtocolVersion = typeof SESSION_PROTOCOL_VERSION

export const isSessionProtocolVersion = (value: unknown): value is SessionProtocolVersion =>
  value === SESSION_PROTOCOL_VERSION
