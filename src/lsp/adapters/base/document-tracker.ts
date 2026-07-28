import { OPEN_DOC_CACHE_MAX } from "./config"

/** Ports the {@link DocumentTracker} needs from its host `LspClient` (pure
 *  structural motion — no behavior change). */
export interface DocumentTrackerPorts {
  /** The client's (overridable, protected) notification seam. */
  sendNotification(method: string, params: unknown): void
  /** Resolve the LSP `languageId` for the file being opened. */
  languageIdFor(filePath: string): string
  /** Drop the URI-keyed diagnostics when a document is forgotten so neither
   *  map grows without bound. */
  forgetDiagnostics(uri: string): void
}

/** State owner for the per-session open-document cache split out of
 *  `LspClient`.
 *
 *  Owns `opened` (LRU Map). Tracks the last synced text and LSP version so a
 *  reused client emits `didChange` instead of serving stale buffers after an
 *  on-disk edit. Iteration order is recency (LRU): {@link syncOpenDocument}
 *  re-inserts on every touch and bounds the size to {@link OPEN_DOC_CACHE_MAX}
 *  so a long session can't retain unbounded text. */
export class DocumentTracker {
  readonly opened = new Map<string, { version: number; text: string }>()

  constructor(private readonly ports: DocumentTrackerPorts) {}

  syncOpenDocument(filePath: string, uri: string, text: string): string {
    const existing = this.opened.get(uri)
    if (!existing) {
      this.ports.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: this.ports.languageIdFor(filePath), version: 1, text },
      })
      this.opened.set(uri, { version: 1, text })
      this.evictOpenDocsToCap(uri)
      return uri
    }
    // Re-insert so the Map's insertion order tracks recency (LRU): the most
    // recently touched doc moves to the tail, the eviction victim is the head.
    this.opened.delete(uri)
    if (existing.text === text) {
      this.opened.set(uri, existing)
      return uri
    }
    const version = existing.version + 1
    this.ports.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
    this.opened.set(uri, { version, text })
    return uri
  }

  /** Bound the per-session open-doc cache: while it exceeds {@link
   *  OPEN_DOC_CACHE_MAX}, `didClose` and forget the least-recently-touched
   *  document (Map iteration order = insertion order = recency, because
   *  {@link syncOpenDocument} re-inserts on every touch). Never evicts the
   *  just-touched `keep` URI. Forgetting drops its retained text AND its
   *  URI-keyed diagnostics so neither map grows without bound. */
  evictOpenDocsToCap(keep: string): void {
    while (this.opened.size > OPEN_DOC_CACHE_MAX) {
      let victim: string | undefined
      for (const uri of this.opened.keys()) {
        if (uri !== keep) {
          victim = uri
          break
        }
      }
      if (victim === undefined) return
      this.forgetDocument(victim)
    }
  }

  /** Close one open document and drop every per-session trace of it. */
  forgetDocument(uri: string): void {
    this.ports.sendNotification("textDocument/didClose", { textDocument: { uri } })
    this.opened.delete(uri)
    this.ports.forgetDiagnostics(uri)
  }
}
