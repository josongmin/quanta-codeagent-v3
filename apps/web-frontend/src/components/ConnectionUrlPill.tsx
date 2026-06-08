import { useCallback, useEffect, useMemo, useState } from "react"
import { cx } from "../lib/classnames"

export interface ConnectionUrlPillProps {
  /** WebSocket URL — used both as the daemon http base (to ask `/network`
   *  for reachable IPs) AND as the source of the daemon port we splice
   *  back into LAN WS URLs that get embedded in the share URL. The PILL
   *  displays the *web app* URL (what someone types into a browser to see
   *  this UI), not the WS endpoint. */
  readonly url: string
  /** Auth token for the daemon WS upgrade. When present, the *copied*
   *  share URL carries it as `?token=<token>` so a phone scanning the
   *  link bootstraps without further config. Display text masks it. */
  readonly token?: string
}

interface NetworkEntry {
  readonly label: string
  readonly family: "IPv4" | "IPv6"
  readonly address: string
}

interface ShareUrl {
  readonly label: string
  readonly family: "IPv4" | "IPv6"
  /** What the user sees — a bare browser URL, no token leak. */
  readonly url: string
  /** What gets written to the clipboard — same URL plus `?ws=…&token=…`
   *  so the receiving SPA can bootstrap a fresh session. */
  readonly copyUrl: string
}

const wsToHttp = (wsUrl: string): string =>
  wsUrl.startsWith("wss://")
    ? `https://${wsUrl.slice("wss://".length)}`
    : wsUrl.startsWith("ws://")
      ? `http://${wsUrl.slice("ws://".length)}`
      : wsUrl

/** Pull the daemon's reachable IPs. We re-use those addresses + the
 *  *current page's* port/protocol to construct browser URLs (the daemon
 *  itself doesn't know which port the SPA is served from). */
const fetchNetworkIps = async (
  wsUrl: string,
): Promise<readonly NetworkEntry[] | null> => {
  try {
    const httpBase = wsToHttp(wsUrl).replace(/\/$/, "")
    const resp = await fetch(`${httpBase}/network`, { cache: "no-store" })
    if (!resp.ok) return null
    const body = (await resp.json()) as {
      urls?: Array<{ label?: string; family?: string; httpUrl?: string }>
    }
    if (!Array.isArray(body.urls)) return null
    const out: NetworkEntry[] = []
    for (const entry of body.urls) {
      if (entry.httpUrl === undefined) continue
      const u = new URL(entry.httpUrl)
      out.push({
        label: entry.label ?? "?",
        family: entry.family === "IPv6" ? "IPv6" : "IPv4",
        address: u.hostname.replace(/^\[/, "").replace(/\]$/, ""),
      })
    }
    return out
  } catch {
    return null
  }
}

const formatHost = (address: string, family: "IPv4" | "IPv6"): string =>
  family === "IPv6" ? `[${address}]` : address

const isLoopbackHost = (h: string): boolean =>
  h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"

/**
 * Click-to-copy pill showing the daemon's connection URL. Header-level so
 * the user can quickly grab the WS endpoint (e.g. to point another tab /
 * device at the same daemon). A 1.6s "copied" toast confirms success.
 *
 * Token handling: by default the rendered text masks the token (`?token=…`)
 * but the *copied* value carries the full token so the URL stays useful.
 * Tooltip explains the masking.
 */
export const ConnectionUrlPill = ({ url, token }: ConnectionUrlPillProps): JSX.Element => {
  const [copied, setCopied] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [networkIps, setNetworkIps] = useState<readonly NetworkEntry[] | null>(
    null,
  )

  // Capture page protocol + port ONCE — these are what we splice the LAN
  // IPs into to form share-able browser URLs.
  const pageProtocol = useMemo(
    () => (typeof window !== "undefined" ? window.location.protocol : "http:"),
    [],
  )
  const pagePort = useMemo(
    () => (typeof window !== "undefined" ? window.location.port : ""),
    [],
  )
  const pageHost = useMemo(
    () => (typeof window !== "undefined" ? window.location.host : ""),
    [],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ips = await fetchNetworkIps(url)
      if (!cancelled) setNetworkIps(ips)
    })()
    return () => {
      cancelled = true
    }
  }, [url])

  // Daemon port + ws scheme from the WS URL we're already connected on.
  // We swap the host with each /network IP to build a LAN-reachable WS URL
  // that gets embedded as `?ws=...` in the copied share URL.
  const daemonPort = useMemo(() => {
    try {
      return new URL(url).port
    } catch {
      return ""
    }
  }, [url])
  const daemonWsScheme = useMemo(() => (url.startsWith("wss://") ? "wss:" : "ws:"), [url])

  const buildCopyUrl = useCallback(
    (pageUrl: string, lanHost: string | null): string => {
      // Mobile-share path: append ?ws + ?token so the receiving SPA's
      // bootstrap (`readQueryConfig` in App.tsx) skips the broken
      // `127.0.0.1:4096` default. When we don't have a LAN host (loopback
      // / no /network data), we can't build a useful share URL — return
      // the bare page URL.
      if (lanHost === null) return pageUrl
      const portPart = daemonPort === "" ? "" : `:${daemonPort}`
      const ws = `${daemonWsScheme}//${lanHost}${portPart}/`
      const params = new URLSearchParams()
      params.set("ws", ws)
      if (token !== undefined && token.length > 0) params.set("token", token)
      return `${pageUrl}?${params.toString()}`
    },
    [daemonPort, daemonWsScheme, token],
  )

  const entries = useMemo<readonly ShareUrl[]>(() => {
    if (pageHost === "") {
      return [{ label: "current", family: "IPv4", url, copyUrl: url }]
    }
    const portPart = pagePort === "" ? "" : `:${pagePort}`
    if (networkIps === null || networkIps.length === 0) {
      // No LAN data yet — fall back to the current page URL.
      const pageUrl = `${pageProtocol}//${pageHost}/`
      return [
        {
          label: "current",
          family: "IPv4",
          url: pageUrl,
          copyUrl: pageUrl,
        },
      ]
    }
    return networkIps.map((ip) => {
      const lanHost = formatHost(ip.address, ip.family)
      const pageUrl = `${pageProtocol}//${lanHost}${portPart}/`
      const isLoopback = ip.label === "loopback" || isLoopbackHost(ip.address)
      return {
        label: ip.label,
        family: ip.family,
        url: pageUrl,
        copyUrl: buildCopyUrl(pageUrl, isLoopback ? null : lanHost),
      }
    })
  }, [networkIps, pageHost, pageProtocol, pagePort, url, buildCopyUrl])

  // Primary = first non-loopback (= LAN-reachable URL the user can share).
  // If only loopback exists, fall back to it.
  const primary = useMemo<ShareUrl>(() => {
    const lan = entries.find(
      (e) =>
        e.label !== "loopback" &&
        !isLoopbackHost(new URL(e.url).hostname),
    )
    const fallbackUrl =
      typeof window !== "undefined" ? `${window.location.origin}/` : url
    return (
      lan ??
      entries[0] ?? {
        label: "current",
        family: "IPv4",
        url: fallbackUrl,
        copyUrl: fallbackUrl,
      }
    )
  }, [entries, url])

  useEffect(() => {
    if (copied === null) return
    const handle = setTimeout(() => setCopied(null), 1600)
    return () => clearTimeout(handle)
  }, [copied])

  const copy = useCallback((raw: string): void => {
    void (async () => {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(raw)
        } else {
          fallbackCopy(raw)
        }
        setCopied(raw)
      } catch (err) {
        console.warn("clipboard copy failed", err)
        try {
          fallbackCopy(raw)
          setCopied(raw)
        } catch {
          // give up
        }
      }
    })()
  }, [])

  const displayUrl = primary.url

  const hasAlts = entries.length > 1
  const isCopiedPrimary = copied === primary.copyUrl
  // Tooltip shows the *display* URL (no token leak); the clipboard
  // payload is `primary.copyUrl` which carries `?ws=…&token=…` when we
  // have something useful to share.
  const copyTitle =
    primary.copyUrl === primary.url
      ? `Click to copy ${primary.url}`
      : `Click to copy share link for ${primary.url} (includes ws + token)`

  // Non-loopback primary ⇒ LAN-reachable (status "ok"); else muted.
  const isLan = primary.label !== "loopback" && primary.label !== "current"
  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => copy(primary.copyUrl)}
        title={copyTitle}
        className={cx(
          "group flex items-center gap-1.5 rounded-full border px-2 py-0.5",
          "text-xs transition",
          isCopiedPrimary
            ? "border-ok/40 bg-ok/10 text-ok"
            : "border-line text-ink-secondary hover:border-line-strong hover:text-ink",
        )}
      >
        <span
          aria-hidden
          className={cx(
            "size-1.5 shrink-0 rounded-full",
            isCopiedPrimary ? "bg-ok" : isLan ? "bg-ok" : "bg-ink-tertiary",
          )}
        />
        <span className="max-w-[22rem] truncate font-mono text-[11px] tracking-tight">
          {isCopiedPrimary ? "copied" : displayUrl}
        </span>
        <span
          className={cx(
            "ml-0.5 text-[9px] uppercase",
            isLan ? "text-ok/80" : "text-ink-tertiary",
          )}
        >
          {primary.label}
        </span>
      </button>
      {hasAlts ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            title="Show all reachable URLs"
            className={cx(
              "ml-1 rounded-full border border-line px-2 py-0.5",
              "text-xs text-ink-secondary hover:border-line-strong hover:text-ink",
            )}
          >
            ▾
          </button>
          {open ? (
            <div
              className={cx(
                "absolute right-0 top-full z-10 mt-1 w-[26rem] max-w-[90vw]",
                "rounded-xl border border-line bg-surface-overlay p-1 shadow-lg",
              )}
            >
              {entries.map((e) => {
                const isCopied = copied === e.copyUrl
                return (
                  <button
                    key={`${e.label}-${e.url}`}
                    type="button"
                    onClick={() => copy(e.copyUrl)}
                    className={cx(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left",
                      "font-mono text-[11px] tracking-tight transition",
                      isCopied
                        ? "bg-ok/10 text-ok"
                        : "text-ink-secondary hover:bg-white/5 hover:text-ink",
                    )}
                  >
                    <span
                      className={cx(
                        "shrink-0 rounded px-1 py-px text-[9px] uppercase tracking-wider",
                        e.label === "loopback"
                          ? "bg-white/5 text-ink-tertiary"
                          : "bg-ok/15 text-ok",
                      )}
                    >
                      {e.label}
                    </span>
                    <span className="flex-1 truncate">{isCopied ? "copied" : e.url}</span>
                    <span aria-hidden className="text-ink-tertiary">
                      {isCopied ? "✓" : "⎘"}
                    </span>
                  </button>
                )
              })}
              <div className="px-2.5 py-1 text-[9px] text-ink-tertiary">
                Open these URLs in a browser on the same network to share the UI
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export const appendTokenQuery = (url: string, token: string): string => {
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

const fallbackCopy = (text: string): void => {
  if (typeof document === "undefined") return
  const el = document.createElement("textarea")
  el.value = text
  el.setAttribute("readonly", "")
  el.style.position = "absolute"
  el.style.left = "-9999px"
  document.body.appendChild(el)
  el.select()
  document.execCommand("copy")
  document.body.removeChild(el)
}
