import { Fragment, lazy, type ReactNode, Suspense } from "react"
import ReactMarkdown from "react-markdown"
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter"
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash"
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff"
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript"
import json from "react-syntax-highlighter/dist/esm/languages/prism/json"
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx"
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown"
import python from "react-syntax-highlighter/dist/esm/languages/prism/python"
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust"
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql"
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx"
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript"
import { tomorrow } from "react-syntax-highlighter/dist/esm/styles/prism"
import remarkGfm from "remark-gfm"
import { detectRichSegmentsGated } from "../../../../src/artifact/rich-markers"
import { cx } from "../lib/classnames"

/* RFC-12 (deferred) — LAZY KaTeX display-math renderer. `katex` (+ its font CSS)
 * stays behind this async boundary and is fetched only when a `$$…$$` segment
 * actually renders — never on first paint. Mirrors `LazyMermaidDiagram` /
 * `LazyPdfPreview`. */
const LazyKatex = lazy(async () => {
  const m = await import("./canvas/KatexDisplay")
  return { default: m.KatexDisplay }
})

/** RFC-12 (deferred) — the display-math render gate. Mirrors the daemon
 *  `QUANTA_KATEX` runtime knob (injected as `VITE_QUANTA_KATEX`). DEFAULT-OFF:
 *  unset ⇒ `$$…$$` renders as plain text (byte-identical to the pre-RFC-12
 *  render). ON ⇒ the `rich-markers` katex segments route through `LazyKatex`. */
const katexEnabled = (): boolean => {
  const v = import.meta.env.VITE_QUANTA_KATEX as string | undefined
  return v === "1" || v === "true"
}

SyntaxHighlighter.registerLanguage("bash", bash)
SyntaxHighlighter.registerLanguage("sh", bash)
SyntaxHighlighter.registerLanguage("diff", diff)
SyntaxHighlighter.registerLanguage("javascript", javascript)
SyntaxHighlighter.registerLanguage("js", javascript)
SyntaxHighlighter.registerLanguage("json", json)
SyntaxHighlighter.registerLanguage("jsx", jsx)
SyntaxHighlighter.registerLanguage("markdown", markdown)
SyntaxHighlighter.registerLanguage("md", markdown)
SyntaxHighlighter.registerLanguage("python", python)
SyntaxHighlighter.registerLanguage("py", python)
SyntaxHighlighter.registerLanguage("rust", rust)
SyntaxHighlighter.registerLanguage("rs", rust)
SyntaxHighlighter.registerLanguage("sql", sql)
SyntaxHighlighter.registerLanguage("tsx", tsx)
SyntaxHighlighter.registerLanguage("typescript", typescript)
SyntaxHighlighter.registerLanguage("ts", typescript)

export interface MarkdownMessageProps {
  readonly text: string
}

/** The ReactMarkdown render body. Extracted so BOTH the gate-OFF whole-text
 *  path and the gate-ON per-`text`-segment path share the exact same markdown
 *  rendering (identical plugin set + component overrides). */
const MarkdownBody = ({ text }: { text: string }): JSX.Element => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code(props) {
          const { inline, className, children, ...rest } = props as {
            inline?: boolean
            className?: string
            children?: ReactNode
          }
          const match = /language-(\w+)/.exec(className ?? "")
          if (inline === true || match === null) {
            return (
              <code
                className={cx(
                  "rounded-md border border-line-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-[0.85em] text-ink",
                  className,
                )}
                {...rest}
              >
                {children}
              </code>
            )
          }
          return (
            <div className="my-2 overflow-hidden rounded-lg border border-code-line bg-code">
              <SyntaxHighlighter
                language={match[1]}
                style={tomorrow}
                PreTag="div"
                wrapLongLines
                customStyle={{
                  // Transparent so the bordered token-styled wrapper shows
                  // through (container = surface-raised + line border).
                  background: "transparent",
                  margin: 0,
                  padding: "0.75rem 0.875rem",
                  borderRadius: 0,
                  fontSize: "0.8rem",
                  // Wrap to the bubble width instead of overflowing
                  // horizontally. `pre-wrap` keeps real newlines + indents;
                  // `break-word` breaks long tokens (URLs, paths, etc.) so
                  // they don't blow past the bubble.
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  overflowX: "hidden",
                }}
                codeTagProps={{
                  style: {
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  },
                }}
              >
                {String(children ?? "").replace(/\n$/, "")}
              </SyntaxHighlighter>
            </div>
          )
        },
        a({ children, ...rest }) {
          return (
            <a
              {...rest}
              className="text-accent underline decoration-accent/40 hover:decoration-accent"
              target="_blank"
              rel="noreferrer noopener"
            >
              {children}
            </a>
          )
        },
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

export const MarkdownMessage = ({ text }: MarkdownMessageProps): JSX.Element => {
  // Default-OFF: unset gate ⇒ `detectRichSegmentsGated(text, false)` returns a
  // SINGLE verbatim `text` segment WITHOUT scanning, so the whole message renders
  // through `MarkdownBody` exactly as it did pre-RFC-12 (byte-identical).
  const segments = detectRichSegmentsGated(text, katexEnabled())
  return (
    <div className="markdown-body whitespace-pre-wrap break-words font-sans text-chat text-ink">
      {segments.map((seg, i) =>
        seg.kind === "katex" ? (
          <Suspense
            // Segments are positional + immutable per render; index key is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rich segments
            key={i}
            fallback={<MarkdownBody text={seg.source} />}
          >
            <LazyKatex body={seg.body ?? ""} source={seg.source} />
          </Suspense>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rich segments
          <Fragment key={i}>
            <MarkdownBody text={seg.source} />
          </Fragment>
        ),
      )}
    </div>
  )
}
