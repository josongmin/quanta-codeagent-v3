/** Chars-per-token heuristic divisor. */
const CHARS_PER_TOKEN = 4;
class WorkingMemoryImpl {
    messages;
    constructor(initial = []) {
        this.messages = [...initial];
    }
    append(message) {
        this.messages.push(message);
    }
    snapshot() {
        return [...this.messages];
    }
    clear() {
        this.messages = [];
    }
    replace(messages) {
        this.messages = [...messages];
    }
    tokenEstimate() {
        let chars = 0;
        for (const m of this.messages) {
            // JSON.stringify can throw on circular refs; messages are plain data.
            chars += JSON.stringify(m)?.length ?? 0;
        }
        return Math.ceil(chars / CHARS_PER_TOKEN);
    }
}
/** Construct an empty (or seeded) {@link WorkingMemory}. */
export const createWorkingMemory = (initial = []) => new WorkingMemoryImpl(initial);
