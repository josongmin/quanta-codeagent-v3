export class SingleWriterLease {
  #holder: string | undefined

  acquire(holderId: string): void {
    if (this.#holder !== undefined && this.#holder !== holderId) {
      throw new Error(`session lease already held by ${this.#holder}`)
    }
    this.#holder = holderId
  }

  assert(holderId: string): void {
    if (this.#holder !== holderId) {
      throw new Error(`session lease owned by ${this.#holder ?? "none"}`)
    }
  }

  release(holderId: string): void {
    if (this.#holder === holderId) this.#holder = undefined
  }
}
