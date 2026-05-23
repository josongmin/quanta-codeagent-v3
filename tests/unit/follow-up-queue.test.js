/**
 * ADR-0037: FIFO ordering, multi-thread isolation, pause/unpause, snapshot
 * round-trip.
 */
import { describe, expect, test } from "bun:test";
import { FollowUpQueue, threadId } from "@/agent/follow-up-queue";
const baseFu = (content, ts = 0) => ({
    content,
    submittedAt: ts,
    submittedTurnId: null,
    metadata: {},
});
describe("FollowUpQueue (ADR-0037)", () => {
    test("enqueue + peek returns the head without popping", () => {
        const q = new FollowUpQueue();
        const tid = threadId("th-a");
        q.enqueue(tid, baseFu("first"));
        q.enqueue(tid, baseFu("second"));
        expect(q.peek(tid)?.content).toBe("first");
        expect(q.sizeFor(tid)).toBe(2);
    });
    test("FIFO popReady ordering when not paused", () => {
        const q = new FollowUpQueue();
        const tid = threadId("th-a");
        q.enqueue(tid, baseFu("a"));
        q.enqueue(tid, baseFu("b"));
        q.enqueue(tid, baseFu("c"));
        const r1 = q.popReady(tid, null);
        expect(r1?.ready.content).toBe("a");
        expect(r1?.remaining.map((f) => f.content)).toEqual(["b", "c"]);
        const r2 = q.popReady(tid, null);
        expect(r2?.ready.content).toBe("b");
    });
    test("popReady returns null while paused, queue unchanged", () => {
        const q = new FollowUpQueue();
        const tid = threadId("th-a");
        q.enqueue(tid, baseFu("queued"));
        expect(q.popReady(tid, "model_streaming")).toBeNull();
        expect(q.popReady(tid, "tool_running")).toBeNull();
        expect(q.popReady(tid, "compaction_in_progress")).toBeNull();
        expect(q.sizeFor(tid)).toBe(1);
        // Unpause ⇒ ready.
        const r = q.popReady(tid, null);
        expect(r?.ready.content).toBe("queued");
    });
    test("multi-thread isolation: enqueue in A does NOT surface in B", () => {
        const q = new FollowUpQueue();
        const a = threadId("th-a");
        const b = threadId("th-b");
        q.enqueue(a, baseFu("from-a"));
        q.enqueue(b, baseFu("from-b"));
        expect(q.peek(a)?.content).toBe("from-a");
        expect(q.peek(b)?.content).toBe("from-b");
        expect(q.sizeFor(a)).toBe(1);
        expect(q.sizeFor(b)).toBe(1);
        expect(q.size()).toBe(2);
    });
    test("drain returns all entries for a thread + clears them", () => {
        const q = new FollowUpQueue();
        const tid = threadId("th-c");
        q.enqueue(tid, baseFu("x"));
        q.enqueue(tid, baseFu("y"));
        const drained = q.drain(tid);
        expect(drained.map((f) => f.content)).toEqual(["x", "y"]);
        expect(q.sizeFor(tid)).toBe(0);
        expect(q.peek(tid)).toBeNull();
    });
    test("drain unknown thread ⇒ empty array (not an error)", () => {
        const q = new FollowUpQueue();
        expect(q.drain(threadId("nope"))).toEqual([]);
    });
    test("ids are deterministic per submission sequence", () => {
        const q = new FollowUpQueue();
        const tid = threadId("th-d");
        const fu1 = q.enqueue(tid, baseFu("p"));
        const fu2 = q.enqueue(tid, baseFu("q"));
        expect(fu1.id).toBe(FollowUpQueue.makeId(tid, 0));
        expect(fu2.id).toBe(FollowUpQueue.makeId(tid, 1));
    });
    test("snapshot round-trip preserves FIFO order across threads", () => {
        const q = new FollowUpQueue();
        const a = threadId("th-a");
        const b = threadId("th-b");
        q.enqueue(a, baseFu("a-1", 1));
        q.enqueue(b, baseFu("b-1", 2));
        q.enqueue(a, baseFu("a-2", 3));
        const snap = q.toSnapshot();
        expect(snap.version).toBe(1);
        const q2 = FollowUpQueue.fromSnapshot(snap);
        const r1 = q2.popReady(a, null);
        const r2 = q2.popReady(a, null);
        const r3 = q2.popReady(b, null);
        expect(r1?.ready.content).toBe("a-1");
        expect(r2?.ready.content).toBe("a-2");
        expect(r3?.ready.content).toBe("b-1");
    });
    test("post-snapshot enqueue uses fresh seq (no id collision)", () => {
        const q = new FollowUpQueue();
        const tid = threadId("th-e");
        q.enqueue(tid, baseFu("a"));
        q.enqueue(tid, baseFu("b"));
        const snap = q.toSnapshot();
        const q2 = FollowUpQueue.fromSnapshot(snap);
        const fu3 = q2.enqueue(tid, baseFu("c"));
        // After 2 entries the next seq must be 2.
        expect(fu3.id).toBe(FollowUpQueue.makeId(tid, 2));
    });
    test("fromSnapshot rejects unknown version", () => {
        expect(() => FollowUpQueue.fromSnapshot({
            version: 99,
            threads: [],
        })).toThrow(/Unsupported/);
    });
    test("peek on empty queue ⇒ null (never throws)", () => {
        const q = new FollowUpQueue();
        expect(q.peek(threadId("never-used"))).toBeNull();
    });
    test("popReady on empty unpaused queue ⇒ null", () => {
        const q = new FollowUpQueue();
        expect(q.popReady(threadId("nope"), null)).toBeNull();
    });
    test("threads() returns active thread ids", () => {
        const q = new FollowUpQueue();
        q.enqueue(threadId("a"), baseFu("x"));
        q.enqueue(threadId("b"), baseFu("y"));
        expect(q.threads().sort()).toEqual([threadId("a"), threadId("b")]);
    });
});
