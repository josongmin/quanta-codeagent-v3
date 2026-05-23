/** DispatchResult shape extracted to break a circular import:
 *  `admissibility-gate.ts` returns this; `dispatch.ts` consumes it. Splitting
 *  the type out of `dispatch.ts` lets both files import it without one having
 *  to depend on the other's full implementation surface. */
export {};
