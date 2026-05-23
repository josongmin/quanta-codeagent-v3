/**
 * Verdict-time grading: decide pass/fail for the captured patch.
 *
 * When the Python harness is wired AND the instance has swebench metadata,
 * grade officially; otherwise (the default) run the local `testCmd`. Never
 * throws — a harness error degrades to passed=false with the cause in
 * `error`. Returns rich evidence so the caller can emit a `verify` trajectory
 * event; pass/fail semantics are unchanged.
 */
import { evaluateWithPythonSwebench } from "../python-swebench";
import { exec } from "./exec";
export const verify = async (instance, patch, sandbox, deps) => {
    if (deps.pythonSwebench && instance.swebench) {
        const evaluate = deps.pythonSwebench.evaluate ?? evaluateWithPythonSwebench;
        const r = await evaluate(instance, patch, deps.pythonSwebench.opts ?? {});
        const command = `python -m swebench.harness.run_evaluation (${instance.swebench.instanceId})`;
        return {
            passed: r.resolved,
            ...(r.resolved ? {} : { error: r.log.slice(0, 500) }),
            command,
            exitCode: r.resolved ? 0 : 1,
            failedTests: [],
            logTail: r.log.slice(-2000),
            reportPath: "",
        };
    }
    const test = await exec(instance.testCmd, sandbox, deps.timeoutMs);
    return {
        passed: test.code === 0,
        command: instance.testCmd,
        exitCode: test.code,
        failedTests: [],
        logTail: `${test.stdout}\n${test.stderr}`.slice(-2000),
        reportPath: "",
    };
};
