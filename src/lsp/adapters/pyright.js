import { LspClient } from "./base";
const DEFAULT_COMMAND = ["pyright-langserver", "--stdio"];
/** A real LSP client for Pyright over stdio. All mechanics live in
 *  {@link LspClient}; Pyright only contributes its launcher and the fact that
 *  every file it sees is Python. */
export class PyrightAdapter extends LspClient {
    constructor(options = {}) {
        super({ defaultCommand: DEFAULT_COMMAND, languageIdFor: () => "python" }, options);
    }
}
