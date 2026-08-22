/** Exhaustiveness guard.
 *
 *  Placing `assertNever(x)` in a `switch` `default` (or a final `else`) makes
 *  TypeScript fail to COMPILE if a new variant is added to the union/enum
 *  without a matching case — turning a "silent fall-through returns undefined"
 *  bug into a build error. The runtime throw only fires if reached via an
 *  unchecked cast (defence in depth).
 *
 *  Usage:
 *    switch (block.type) {
 *      case "text": return ...
 *      case "image": return ...
 *      default: return assertNever(block, "ContentBlock")
 *    }
 */
export const assertNever = (x: never, label = "value"): never => {
  throw new Error(`Unreachable: unhandled ${label}: ${JSON.stringify(x)}`)
}
