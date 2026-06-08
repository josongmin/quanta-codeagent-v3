import type { ReactNode } from "react"
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
import { cx } from "../lib/classnames"

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

export const MarkdownMessage = ({
  text,
}: MarkdownMessageProps): JSX.Element => {
  return (
    <div className="markdown-body whitespace-pre-wrap break-words font-sans text-chat text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const {
              inline,
              className,
              children,
              ...rest
            } = props as {
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
              <div className="my-2 overflow-hidden rounded-lg border border-line bg-surface-raised">
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
    </div>
  )
}
