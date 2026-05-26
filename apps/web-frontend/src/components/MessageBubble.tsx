import type { ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
// We use the bundled `tomorrow` Prism theme — keeps the bundle dep-free of
// extra theme JSON. Future polish: dynamic-import a darker theme.
import { tomorrow } from "react-syntax-highlighter/dist/esm/styles/prism"
import remarkGfm from "remark-gfm"
import { cx } from "../lib/classnames"
import type { UiMessage } from "../types/protocol"

export interface MessageBubbleProps {
  readonly message: UiMessage
}

const ROLE_STYLES: Record<UiMessage["role"], string> = {
  user: "bg-neutral-800 text-neutral-100 self-end",
  assistant: "bg-neutral-900 text-neutral-100 border border-neutral-800",
  system: "bg-neutral-900/60 text-neutral-400 italic text-sm",
  error: "bg-red-950/60 text-red-200 border border-red-900",
}

const ROLE_LABEL: Record<UiMessage["role"], string> = {
  user: "you",
  assistant: "quanta",
  system: "system",
  error: "error",
}

export const MessageBubble = ({ message }: MessageBubbleProps): JSX.Element => {
  return (
    <div
      className={cx(
        "max-w-[80%] rounded-lg px-3 py-2 font-mono text-sm shadow-sm",
        message.role === "user" ? "ml-auto" : "mr-auto",
        ROLE_STYLES[message.role],
      )}
    >
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-500">
        <span>{ROLE_LABEL[message.role]}</span>
        <time dateTime={message.timestamp}>
          {formatTime(message.timestamp)}
        </time>
      </div>
      <div className="markdown-body whitespace-pre-wrap break-words leading-relaxed">
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
                      "rounded bg-neutral-950 px-1 py-0.5 text-xs",
                      className,
                    )}
                    {...rest}
                  >
                    {children}
                  </code>
                )
              }
              return (
                <SyntaxHighlighter
                  language={match[1]}
                  style={tomorrow}
                  PreTag="div"
                  customStyle={{
                    background: "rgb(10 10 10)",
                    margin: 0,
                    borderRadius: "0.375rem",
                    fontSize: "0.8rem",
                  }}
                >
                  {String(children ?? "").replace(/\n$/, "")}
                </SyntaxHighlighter>
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
          {message.text}
        </ReactMarkdown>
      </div>
    </div>
  )
}

const formatTime = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}
