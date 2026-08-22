/**
 * ADR-0083 multi-modal extension — `/image add | list | clear` slash command +
 * single-shot `ImageQueue` lifecycle.
 *
 * Coverage:
 *   - `/image add <path>` queues an `ImageBlock` (path resolved against cwd).
 *   - Invalid path → exit 1 + clear error message; queue untouched.
 *   - `/image list` prints queued entries; empty queue prints "(none queued)".
 *   - `/image clear` empties the queue idempotently.
 *   - Adding multiple paths in a single invocation enqueues all of them.
 *   - Queue cap (`maxSize`) rejects the over-cap add (no partial enqueue).
 *   - Drain is single-shot: returns + clears atomically.
 *   - Bare `/image` (no subcommand) behaves like `list`.
 *   - Unknown subcommand prints usage banner and exits 1.
 *   - End-to-end carry: a queued image flows through `drain()` and is empty
 *     on the SECOND call (single-shot semantics).
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runImageCmd } from "../../../src/apps/cli/image-cmd"
import { createImageQueue, IMAGE_QUEUE_DEFAULT_MAX } from "../../../src/apps/cli/image-queue"

const work = mkdtempSync(join(tmpdir(), "quanta-image-cmd-"))
const writeImg = (name: string, bytes: Uint8Array): string => {
  const p = join(work, name)
  writeFileSync(p, bytes)
  return p
}

interface Streams {
  out: string
  err: string
}
const buildCtx = (
  cwd: string,
  queue: ReturnType<typeof createImageQueue>,
): { streams: Streams; ctx: Parameters<typeof runImageCmd>[1] } => {
  const streams: Streams = { out: "", err: "" }
  return {
    streams,
    ctx: {
      out: (s) => {
        streams.out += s
      },
      err: (s) => {
        streams.err += s
      },
      cwd,
      queue,
    },
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe("/image cmd + ImageQueue", () => {
  test("/image add <path> queues an ImageBlock and prints the basename", () => {
    const p = writeImg("a.png", PNG_BYTES)
    const queue = createImageQueue()
    const { streams, ctx } = buildCtx(work, queue)
    const code = runImageCmd(`/image add ${p}`, ctx)
    expect(code).toBe(0)
    expect(streams.out).toContain("queued a.png")
    expect(queue.size()).toBe(1)
    const items = queue.list()
    expect(items[0]?.block.type).toBe("image")
    expect(items[0]?.block.mediaType).toBe("image/png")
  })

  test("/image add with invalid path returns 1 + leaves queue untouched", () => {
    const queue = createImageQueue()
    const { streams, ctx } = buildCtx(work, queue)
    const code = runImageCmd("/image add /nonexistent/path.png", ctx)
    expect(code).toBe(1)
    expect(streams.err).toMatch(/\/image add:/)
    expect(queue.size()).toBe(0)
  })

  test("/image add with unsupported extension throws via loader", () => {
    const p = writeImg("bad.bmp", PNG_BYTES)
    const queue = createImageQueue()
    const { streams, ctx } = buildCtx(work, queue)
    const code = runImageCmd(`/image add ${p}`, ctx)
    expect(code).toBe(1)
    expect(streams.err).toMatch(/unsupported image type/)
    expect(queue.size()).toBe(0)
  })

  test("/image list shows queued entries; empty queue prints (none queued)", () => {
    const queue = createImageQueue()
    const { streams: empty, ctx: ctxEmpty } = buildCtx(work, queue)
    expect(runImageCmd("/image list", ctxEmpty)).toBe(0)
    expect(empty.out).toContain("(none queued)")

    const p = writeImg("b.jpg", PNG_BYTES)
    runImageCmd(`/image add ${p}`, ctxEmpty)
    const { streams: filled, ctx: ctxFilled } = buildCtx(work, queue)
    expect(runImageCmd("/image list", ctxFilled)).toBe(0)
    expect(filled.out).toContain("1 queued")
    expect(filled.out).toContain("b.jpg")
  })

  test("/image clear empties the queue + is idempotent", () => {
    const queue = createImageQueue()
    const p = writeImg("c.gif", PNG_BYTES)
    const { ctx: ctxAdd } = buildCtx(work, queue)
    runImageCmd(`/image add ${p}`, ctxAdd)
    expect(queue.size()).toBe(1)
    const { streams, ctx } = buildCtx(work, queue)
    expect(runImageCmd("/image clear", ctx)).toBe(0)
    expect(streams.out).toContain("cleared (1 dropped)")
    expect(queue.size()).toBe(0)
    // Idempotent.
    expect(runImageCmd("/image clear", ctx)).toBe(0)
  })

  test("/image add accepts multiple paths in a single invocation", () => {
    const a = writeImg("multi-a.png", PNG_BYTES)
    const b = writeImg("multi-b.webp", PNG_BYTES)
    const queue = createImageQueue()
    const { ctx } = buildCtx(work, queue)
    const code = runImageCmd(`/image add ${a} ${b}`, ctx)
    expect(code).toBe(0)
    expect(queue.size()).toBe(2)
    const paths = queue.list().map((e) => e.path)
    expect(paths).toEqual([a, b])
  })

  test("queue cap rejects the over-cap add (default 5)", () => {
    expect(IMAGE_QUEUE_DEFAULT_MAX).toBe(5)
    const queue = createImageQueue({ maxSize: 2 })
    const { ctx } = buildCtx(work, queue)
    const p1 = writeImg("cap-1.png", PNG_BYTES)
    const p2 = writeImg("cap-2.png", PNG_BYTES)
    const p3 = writeImg("cap-3.png", PNG_BYTES)
    expect(runImageCmd(`/image add ${p1}`, ctx)).toBe(0)
    expect(runImageCmd(`/image add ${p2}`, ctx)).toBe(0)
    const { streams, ctx: ctx3 } = buildCtx(work, queue)
    expect(runImageCmd(`/image add ${p3}`, ctx3)).toBe(1)
    expect(streams.err).toMatch(/queue is full/)
    expect(queue.size()).toBe(2)
  })

  test("/image drain returns + clears atomically (single-shot)", () => {
    const queue = createImageQueue()
    const p = writeImg("drain.png", PNG_BYTES)
    const { ctx } = buildCtx(work, queue)
    runImageCmd(`/image add ${p}`, ctx)
    const drained = queue.drain()
    expect(drained).toHaveLength(1)
    expect(queue.size()).toBe(0)
    // Second drain returns empty array.
    expect(queue.drain()).toHaveLength(0)
  })

  test("bare /image (no subcommand) lists", () => {
    const queue = createImageQueue()
    const { streams, ctx } = buildCtx(work, queue)
    const code = runImageCmd("/image", ctx)
    expect(code).toBe(0)
    expect(streams.out).toContain("(none queued)")
  })

  test("unknown subcommand exits 1 + prints usage banner", () => {
    const queue = createImageQueue()
    const { streams, ctx } = buildCtx(work, queue)
    const code = runImageCmd("/image bogus", ctx)
    expect(code).toBe(1)
    expect(streams.err).toMatch(/unknown subcommand/)
  })

  test("/image add with no paths exits 1", () => {
    const queue = createImageQueue()
    const { streams, ctx } = buildCtx(work, queue)
    const code = runImageCmd("/image add", ctx)
    expect(code).toBe(1)
    expect(streams.err).toMatch(/expected one or more paths/)
    expect(queue.size()).toBe(0)
  })
})
