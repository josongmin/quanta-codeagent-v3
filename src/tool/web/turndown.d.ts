/**
 * Ambient module declaration for `turndown@7.2.4` (no bundled / `@types/*`
 * package). Surface narrowed to what `html-to-markdown.ts` uses:
 *
 *   - `TurndownService` default-export class with `(options?) → instance`
 *   - `turndown(html: string) → string`
 *   - `remove(filter: string | string[]) → this`
 *   - `addRule(key: string, rule: Rule) → this` (kept for follow-up
 *     custom-rule plumbing; not exercised today)
 *   - configurable construction options (heading / code-block / bullet /
 *     emphasis / link styles)
 *
 * Wider `turndown` API (use(), keep(), escape()) is intentionally omitted —
 * `skipLibCheck: true` means a future caller that needs it can extend this
 * file without breaking unrelated typechecks.
 */

declare module "turndown" {
  export interface TurndownOptions {
    headingStyle?: "setext" | "atx"
    hr?: string
    bulletListMarker?: "-" | "+" | "*"
    codeBlockStyle?: "indented" | "fenced"
    fence?: "```" | "~~~"
    emDelimiter?: "_" | "*"
    strongDelimiter?: "**" | "__"
    linkStyle?: "inlined" | "referenced"
    linkReferenceStyle?: "full" | "collapsed" | "shortcut"
    br?: string
    preformattedCode?: boolean
  }

  export interface Rule {
    filter: string | string[] | ((node: unknown, options: TurndownOptions) => boolean)
    replacement?: (content: string, node: unknown, options: TurndownOptions) => string
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions)
    turndown(html: string): string
    remove(filter: string | string[]): this
    addRule(key: string, rule: Rule): this
    keep(filter: string | string[]): this
    use(
      plugin: ((service: TurndownService) => void) | Array<(service: TurndownService) => void>,
    ): this
    escape(text: string): string
  }
}
