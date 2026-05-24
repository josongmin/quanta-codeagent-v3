/** ADR-0141 / ADR-0143 — default `SignatureHelpPort` adapter.
 *
 *  Wires the canonical `SignatureHelpPort` to a `LspClient` (`./base.ts`) via
 *  the `requestSignatureHelp` wire method added in ADR-0143.
 *  Plane-clean: imports only `../ports/signature-help-port`. */

import type { SignatureHelpPort, SignatureInfo } from "../ports/signature-help-port"

/** Subset of `LspClient` consumed by this adapter. */
export interface SignatureHelpLspClient {
  requestSignatureHelp(
    file: string,
    line: number,
    col: number,
  ): Promise<readonly SignatureInfo[] | null>
}

export class DefaultSignatureHelpAdapter implements SignatureHelpPort {
  constructor(private readonly client: SignatureHelpLspClient) {}

  async signatureHelp(
    file: string,
    line: number,
    col: number,
  ): Promise<readonly SignatureInfo[] | null> {
    return await this.client.requestSignatureHelp(file, line, col)
  }
}
