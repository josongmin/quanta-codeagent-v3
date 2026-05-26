import { SessionProtocolError } from "@/protocol/session"

export class SessionDuplicateCommandError extends SessionProtocolError {
  constructor(readonly commandId: string) {
    super(`duplicate commandId ${commandId}`)
    this.name = "SessionDuplicateCommandError"
  }
}
