import { useEffect, useRef, type RefObject } from "react"
import type { UiMessage } from "../types/protocol"
import { InputBar } from "./InputBar"
import { MessageBubble } from "./MessageBubble"

export interface ChatPanelProps {
  readonly messages: readonly UiMessage[]
  readonly draft: string
  readonly disabled: boolean
  readonly inputRef: RefObject<HTMLTextAreaElement>
  readonly onDraftChange: (next: string) => void
  readonly onSubmit: (text: string) => void
}

export const ChatPanel = ({
  messages,
  draft,
  disabled,
  inputRef,
  onDraftChange,
  onSubmit,
}: ChatPanelProps): JSX.Element => {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when a new message arrives. We compare lengths,
  // not identities, so this fires once per appended message.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
  }, [messages.length])

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((msg) => (
              <li key={msg.id}>
                <MessageBubble message={msg} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <InputBar
        value={draft}
        disabled={disabled}
        inputRef={inputRef}
        onChange={onDraftChange}
        onSubmit={onSubmit}
      />
    </main>
  )
}

const EmptyState = (): JSX.Element => (
  <div className="flex h-full items-center justify-center">
    <div className="max-w-md text-center text-sm text-neutral-500">
      <p>No messages yet.</p>
      <p className="mt-1">
        Type a prompt below and press{" "}
        <kbd className="rounded bg-neutral-800 px-1 py-0.5 text-xs">Enter</kbd>{" "}
        to start a turn.
      </p>
    </div>
  </div>
)
