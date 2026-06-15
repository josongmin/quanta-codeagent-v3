export interface HereDocLowering {
  readonly command: string
  readonly lowered: boolean
}

interface HereDocHeader {
  readonly prefix: string
  readonly delimiter: string
  readonly stripTabs: boolean
}

const unchanged = (command: string): HereDocLowering => ({ command, lowered: false })

const shellSingleQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

const parseQuotedDelimiter = (
  line: string,
  start: number,
  quote: "'" | '"',
): { readonly value: string; readonly end: number } | undefined => {
  let value = ""
  for (let i = start + 1; i < line.length; i += 1) {
    const ch = line[i]
    if (quote === '"' && ch === "\\" && i + 1 < line.length) {
      value += line[i + 1]
      i += 1
      continue
    }
    if (ch === quote) return { value, end: i + 1 }
    value += ch
  }
  return undefined
}

const parseUnquotedDelimiter = (
  line: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined => {
  let end = start
  while (end < line.length && !/\s/.test(line[end] ?? "")) end += 1
  if (end === start) return undefined
  return { value: line.slice(start, end), end }
}

const parseDelimiter = (
  line: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined => {
  const ch = line[start]
  if (ch === "'" || ch === '"') return parseQuotedDelimiter(line, start, ch)
  return parseUnquotedDelimiter(line, start)
}

interface ScanState {
  readonly index: number
  readonly quote: "'" | '"' | undefined
  readonly outside: boolean
}

const scanShellChar = (line: string, index: number, quote: "'" | '"' | undefined): ScanState => {
  const ch = line[index]
  if (quote === "'") return { index, quote: ch === "'" ? undefined : quote, outside: false }
  if (quote === '"') {
    if (ch === "\\" && index + 1 < line.length) return { index: index + 1, quote, outside: false }
    return { index, quote: ch === '"' ? undefined : quote, outside: false }
  }
  if (ch === "\\" && index + 1 < line.length) {
    return { index: index + 1, quote: undefined, outside: false }
  }
  if (ch === "'" || ch === '"') return { index, quote: ch, outside: false }
  return { index, quote: undefined, outside: true }
}

const findHereDocOperator = (
  line: string,
): { readonly index: number; readonly stripTabs: boolean } | undefined => {
  let quote: "'" | '"' | undefined
  for (let i = 0; i < line.length; i += 1) {
    const scan = scanShellChar(line, i, quote)
    quote = scan.quote
    i = scan.index
    if (!scan.outside) continue
    if (line[i] === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      return { index: i, stripTabs: line[i + 2] === "-" }
    }
  }
  return undefined
}

const parseHeader = (line: string): HereDocHeader | undefined => {
  const operator = findHereDocOperator(line)
  if (operator === undefined) return undefined

  let cursor = operator.index + (operator.stripTabs ? 3 : 2)
  while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor += 1

  const delimiter = parseDelimiter(line, cursor)
  if (delimiter === undefined || delimiter.value.length === 0) return undefined
  if (line.slice(delimiter.end).trim().length > 0) return undefined

  const prefix = line.slice(0, operator.index).trimEnd()
  if (prefix.length === 0) return undefined
  return { prefix, delimiter: delimiter.value, stripTabs: operator.stripTabs }
}

const bodyLineFor = (line: string, stripTabs: boolean): string =>
  stripTabs ? line.replace(/^\t/, "") : line

const closingLineFor = (line: string, stripTabs: boolean): string =>
  stripTabs ? line.replace(/^\t+/, "") : line

/** Lower a single simple here-doc into a pipe for read-mode Seatbelt.
 *
 * macOS `/bin/bash` materializes here-docs through broad `/tmp` writes under
 * Seatbelt, ignoring scoped TMPDIR holes. In read-mode that broad write grant
 * is not acceptable. This parser only accepts the simple one-command shape
 * models use for repro scripts (`cmd <<'EOF'\n...\nEOF`) and leaves every
 * compound or ambiguous shell program byte-identical.
 */
export const lowerSimpleHereDocForReadMode = (command: string): HereDocLowering => {
  const lines = command.split(/\r?\n/)
  if (lines.length < 3) return unchanged(command)

  const header = parseHeader(lines[0] ?? "")
  if (header === undefined) return unchanged(command)

  const body: string[] = []
  let closingIndex: number | undefined
  for (let i = 1; i < lines.length; i += 1) {
    if (closingLineFor(lines[i] ?? "", header.stripTabs) === header.delimiter) {
      closingIndex = i
      break
    }
    body.push(bodyLineFor(lines[i] ?? "", header.stripTabs))
  }
  if (closingIndex === undefined) return unchanged(command)

  const suffix = lines.slice(closingIndex + 1).join("\n")
  if (suffix.trim().length > 0) return unchanged(command)

  return {
    command: `printf '%s\\n' ${shellSingleQuote(body.join("\n"))} | ${header.prefix}`,
    lowered: true,
  }
}
