/**
 * §4.3 integration fixture — a minimal side-agent CHILD worker.
 *
 * Boots, beacons `ready`, and on receiving a `charter` posts one `finding`
 * derived from the charter task, then on `shutdown` exits cleanly. Driven by the
 * REAL `nodeProcessForkPort` to prove the OS fork + IPC + supervised lifecycle
 * works end-to-end (no mocks).
 *
 * The behaviour is parameterised by argv[2]:
 *   - "normal"  → ready → on charter: post finding → on shutdown: exit(0)
 *   - "crash"   → ready → exit(1) immediately (drives the supervisor's respawn)
 */

const mode = process.argv[2] ?? "normal"

const send = (msg) => {
  if (typeof process.send === "function") process.send(msg)
}

process.on("message", (msg) => {
  if (msg && msg.kind === "charter") {
    send({
      kind: "finding",
      summary: `worked on: ${msg.task}`,
      detail: `turns=${msg.maxTurnsPerWake}`,
    })
  }
  if (msg && msg.kind === "shutdown") {
    process.exit(0)
  }
})

// Beacon ready once the message handler is wired.
send({ kind: "ready" })

if (mode === "crash") {
  // Simulate an immediate crash after booting.
  process.exit(1)
}
