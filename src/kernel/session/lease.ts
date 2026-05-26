import { SessionProtocolValidationError } from "@/protocol/session"

export class SessionSingleWriterLeaseError extends SessionProtocolValidationError {
  constructor(
    issue: "single_writer_lease_held" | "single_writer_lease_holder_required",
    message: string,
  ) {
    super(issue, message)
    this.name = "SessionSingleWriterLeaseError"
  }
}

export class SingleWriterLease {
  #holder: string | undefined

  acquire(holderId: string): void {
    if (holderId === "") {
      throw new SessionSingleWriterLeaseError(
        "single_writer_lease_holder_required",
        "session lease requires a non-empty holder id",
      )
    }
    if (this.#holder !== undefined && this.#holder !== holderId) {
      throw new SessionSingleWriterLeaseError(
        "single_writer_lease_held",
        `session lease already held by ${this.#holder}`,
      )
    }
    this.#holder = holderId
  }

  assert(holderId: string): void {
    if (this.#holder !== holderId) {
      throw new SessionSingleWriterLeaseError(
        "single_writer_lease_held",
        `session lease owned by ${this.#holder ?? "none"}`,
      )
    }
  }

  release(holderId: string): void {
    if (this.#holder === holderId) this.#holder = undefined
  }

  currentHolder(): string | undefined {
    return this.#holder
  }

  async runWith<T>(holderId: string, task: () => Promise<T> | T): Promise<T> {
    this.acquire(holderId)
    try {
      return await task()
    } finally {
      this.release(holderId)
    }
  }
}
