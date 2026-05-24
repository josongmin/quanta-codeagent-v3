/** ADR-0141 / ADR-0143 — default `FormatPort` adapter.
 *
 *  Wires the canonical `FormatPort` to a `LspClient` (`./base.ts`) via the
 *  `requestFormatting` wire method added in ADR-0143. Whole-file format ⇒
 *  `textDocument/formatting`; range format ⇒ `textDocument/rangeFormatting`.
 *  Plane-clean: imports only `../ports/format-port`. */

import type { FormatPort, FormatRange, TextEdit } from "../ports/format-port"

/** Subset of `LspClient` consumed by this adapter. */
export interface FormatLspClient {
  requestFormatting(
    file: string,
    range?: FormatRange,
    signal?: AbortSignal,
  ): Promise<readonly TextEdit[] | null>
}

export class DefaultFormatAdapter implements FormatPort {
  constructor(private readonly client: FormatLspClient) {}

  async format(
    file: string,
    range?: FormatRange,
    signal?: AbortSignal,
  ): Promise<readonly TextEdit[] | null> {
    // Spread the optional `range` so `undefined` stays out of the call site
    // (exactOptionalPropertyTypes). The underlying `LspClient.requestFormatting`
    // distinguishes `undefined` (whole-file) from a real range.
    return range === undefined
      ? await this.client.requestFormatting(file, undefined, signal)
      : await this.client.requestFormatting(file, range, signal)
  }
}
