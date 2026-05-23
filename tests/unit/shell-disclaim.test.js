import { describe, expect, test } from "bun:test";
import { DockerSandbox } from "@/runtime/sandbox";
import { defaultDisclaimedBashArgv, disclaimedShellArgv, isShellInterp, SHELL_INTERPS, } from "@/runtime/shell-disclaim";
describe("SHELL_INTERPS", () => {
    test("exactly bash / zsh / sh", () => {
        expect(SHELL_INTERPS).toEqual(["bash", "zsh", "sh"]);
    });
});
describe("isShellInterp", () => {
    test("recognises the three supported interps", () => {
        expect(isShellInterp("bash")).toBe(true);
        expect(isShellInterp("zsh")).toBe(true);
        expect(isShellInterp("sh")).toBe(true);
    });
    test("rejects unsupported interps", () => {
        expect(isShellInterp("fish")).toBe(false);
        expect(isShellInterp("pwsh")).toBe(false);
        expect(isShellInterp("")).toBe(false);
    });
});
describe("disclaimedShellArgv", () => {
    test("bash skips both profile and rc", () => {
        expect(disclaimedShellArgv("bash", "echo x")).toEqual([
            "bash",
            "--noprofile",
            "--norc",
            "-c",
            "echo x",
        ]);
    });
    test("zsh skips rcs via -f", () => {
        expect(disclaimedShellArgv("zsh", "echo x")).toEqual(["zsh", "-f", "-c", "echo x"]);
    });
    test("sh -c passes command through (no dotfiles in non-login non-interactive sh)", () => {
        expect(disclaimedShellArgv("sh", "echo x")).toEqual(["sh", "-c", "echo x"]);
    });
    test("command argument is verbatim — caller owns quoting/escaping", () => {
        const result = disclaimedShellArgv("bash", "echo 'has spaces' && pwd");
        expect(result[result.length - 1]).toBe("echo 'has spaces' && pwd");
    });
});
describe("defaultDisclaimedBashArgv", () => {
    test("equals disclaimedShellArgv('bash', ...)", () => {
        expect(defaultDisclaimedBashArgv("echo x")).toEqual(disclaimedShellArgv("bash", "echo x"));
    });
});
describe("DockerSandbox.buildArgv — disclaimShell tail swap", () => {
    const sb = new DockerSandbox();
    test("disclaimShell:true ⇒ tail is image + disclaimed bash argv (no -lc)", () => {
        const argv = sb.buildArgv("echo hi", { disclaimShell: true });
        expect(argv.slice(-6)).toEqual([
            "node:22-slim",
            "bash",
            "--noprofile",
            "--norc",
            "-c",
            "echo hi",
        ]);
        expect(argv).not.toContain("-lc");
    });
    test("disclaimShell:false / unset ⇒ legacy `bash -lc <command>` tail (byte-identical)", () => {
        const unset = sb.buildArgv("echo hi", {});
        expect(unset.slice(-4)).toEqual(["node:22-slim", "bash", "-lc", "echo hi"]);
        const explicit = sb.buildArgv("echo hi", { disclaimShell: false });
        expect(explicit.slice(-4)).toEqual(["node:22-slim", "bash", "-lc", "echo hi"]);
        expect(unset).toEqual(explicit);
    });
});
