import { extname } from "node:path";
import { LspClient } from "./base";
const DEFAULT_COMMAND = ["typescript-language-server", "--stdio"];
/** Pick the LSP `languageId` from a file extension. typescript-language-server
 *  needs the JSX/TSX variants distinguished or it parses `.tsx` as plain TS. */
export const languageIdFor = (filePath) => {
    switch (extname(filePath).toLowerCase()) {
        case ".tsx":
            return "typescriptreact";
        case ".jsx":
            return "javascriptreact";
        case ".js":
        case ".mjs":
        case ".cjs":
            return "javascript";
        default:
            return "typescript";
    }
};
/** A real LSP client for typescript-language-server over stdio. All mechanics
 *  live in {@link LspClient}; this adapter only contributes its launcher and
 *  the JS/TS/JSX/TSX `languageId` mapping. */
export class TypescriptAdapter extends LspClient {
    constructor(options = {}) {
        super({ defaultCommand: DEFAULT_COMMAND, languageIdFor }, options);
    }
}
