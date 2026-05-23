/** Unit-test harness: re-exports the integration harness (which is environment-agnostic).
 *  Single source of truth for ScriptedLLM / FakeLLM / RecordingStream / cfg / withTimeout. */
export * from "../integration/_harness";
