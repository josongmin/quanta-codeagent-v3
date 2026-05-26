import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { areMessageBubblePropsEqual, MessageBubble } from "./MessageBubble"
import type { UiMessage } from "../types/protocol"

const baseMessage: UiMessage = {
  id: "message-1",
  role: "user",
  text: "",
  timestamp: "2026-05-26T00:00:00.000Z",
}

describe("MessageBubble", () => {
  it("shrinks image-only bubbles to fit the attachment", () => {
    const markup = renderToStaticMarkup(
      <MessageBubble
        message={{
          ...baseMessage,
          images: [{ type: "image", mediaType: "image/png", data: "ZmFrZQ==" }],
        }}
      />,
    )

    expect(markup).toContain("w-fit")
    expect(markup).toContain("max-w-[80%]")
    expect(markup).toContain("max-w-full")
  })

  it("keeps text bubbles on the standard transcript width", () => {
    const markup = renderToStaticMarkup(
      <MessageBubble
        message={{
          ...baseMessage,
          text: "hello",
          images: [{ type: "image", mediaType: "image/png", data: "ZmFrZQ==" }],
        }}
      />,
    )

    expect(markup).not.toContain("w-fit")
  })

  it("reuses the bubble when only the message object identity changes", () => {
    const left: UiMessage = {
      ...baseMessage,
      role: "assistant",
      text: "```ts\nconst x = 1\n```",
      images: [{ type: "image", mediaType: "image/png", data: "ZmFrZQ==" }],
    }
    const right: UiMessage = {
      ...left,
      images: [{ type: "image", mediaType: "image/png", data: "ZmFrZQ==" }],
    }

    expect(
      areMessageBubblePropsEqual({ message: left }, { message: right }),
    ).toBe(true)
  })

  it("invalidates the memo fence when the transcript content changes", () => {
    const left: UiMessage = {
      ...baseMessage,
      role: "assistant",
      text: "before",
    }
    const right: UiMessage = {
      ...left,
      text: "after",
    }

    expect(
      areMessageBubblePropsEqual({ message: left }, { message: right }),
    ).toBe(false)
  })

  it("invalidates the memo fence when streaming mode flips", () => {
    const message: UiMessage = {
      ...baseMessage,
      role: "assistant",
      text: "partial answer",
    }

    expect(
      areMessageBubblePropsEqual(
        { message, isStreaming: true },
        { message, isStreaming: false },
      ),
    ).toBe(false)
  })
})
