import { describe, expect, test } from "bun:test"
import { classifyCodeShape, classifyCommandShape, classifyPath } from "@/security"

const HOME = "/home/alice"

describe("classifyPath — dotfile / extension / SSH / tree rules", () => {
  test(".env and .env.local are secret", () => {
    expect(classifyPath("/repo/.env", HOME)).toBe("secret")
    expect(classifyPath("/repo/.env.local", HOME)).toBe("secret")
    expect(classifyPath("/repo/.env.production", HOME)).toBe("secret")
  })

  test(".netrc / .pgpass / shell histories are secret", () => {
    expect(classifyPath(`${HOME}/.netrc`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.pgpass`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.bash_history`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.zsh_history`, HOME)).toBe("secret")
  })

  test(".pem / .key / .p12 / .pfx are secret", () => {
    expect(classifyPath("/etc/ssl/private.pem", HOME)).toBe("secret")
    expect(classifyPath("/var/keys/server.key", HOME)).toBe("secret")
    expect(classifyPath("/x/y.p12", HOME)).toBe("secret")
    expect(classifyPath("/x/y.pfx", HOME)).toBe("secret")
  })

  test("SSH private keys are secret", () => {
    expect(classifyPath(`${HOME}/.ssh/id_rsa`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.ssh/id_ed25519`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.ssh/work_rsa`, HOME)).toBe("secret")
  })

  test("SSH public keys / known_hosts / config are NOT secret", () => {
    expect(classifyPath(`${HOME}/.ssh/id_rsa.pub`, HOME)).not.toBe("secret")
    expect(classifyPath(`${HOME}/.ssh/known_hosts`, HOME)).not.toBe("secret")
    expect(classifyPath(`${HOME}/.ssh/config`, HOME)).not.toBe("secret")
  })

  test("AWS / GitHub CLI / kube config files are secret", () => {
    expect(classifyPath(`${HOME}/.aws/credentials`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.aws/config`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.config/gh/hosts.yml`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.kube/config`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.docker/config.json`, HOME)).toBe("secret")
  })

  test("git-credentials / legacy dockercfg / gcloud ADC are secret", () => {
    expect(classifyPath(`${HOME}/.git-credentials`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.dockercfg`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.config/gcloud/application_default_credentials.json`, HOME)).toBe(
      "secret",
    )
  })

  test("~/.gnupg/** is secret regardless of basename", () => {
    expect(classifyPath(`${HOME}/.gnupg/private-keys-v1.d/abc.key`, HOME)).toBe("secret")
    expect(classifyPath(`${HOME}/.gnupg/pubring.kbx`, HOME)).toBe("secret")
  })

  test("home expansion (~) collapses against supplied home", () => {
    expect(classifyPath("~/.aws/credentials", HOME)).toBe("secret")
    expect(classifyPath("~/.ssh/id_rsa", HOME)).toBe("secret")
  })

  test("~/.config / ~/.cache are internal (not secret)", () => {
    expect(classifyPath(`${HOME}/.config/foo.toml`, HOME)).toBe("internal")
    expect(classifyPath(`${HOME}/.cache/blob.bin`, HOME)).toBe("internal")
  })

  test("ordinary repo path is public", () => {
    expect(classifyPath("/repo/src/index.ts", HOME)).toBe("public")
    expect(classifyPath("/repo/README.md", HOME)).toBe("public")
  })
})

describe("classifyCommandShape — first-token + arg shape", () => {
  test("bare printenv / env dump are secret", () => {
    expect(classifyCommandShape("printenv")).toBe("secret")
    expect(classifyCommandShape("env")).toBe("secret")
  })

  test("printenv / env WITH args are public (single var)", () => {
    expect(classifyCommandShape("printenv HOME")).toBe("public")
    expect(classifyCommandShape("env LANG=C foo")).toBe("public")
  })

  test("aws credential printers are secret", () => {
    expect(classifyCommandShape("aws configure list-profiles")).toBe("secret")
    expect(classifyCommandShape("aws configure list")).toBe("secret")
    expect(classifyCommandShape("aws sts get-caller-identity")).toBe("secret")
  })

  test("aws non-credential commands are public", () => {
    expect(classifyCommandShape("aws s3 ls")).toBe("public")
    expect(classifyCommandShape("aws ec2 describe-instances")).toBe("public")
  })

  test("gcloud auth printers are secret", () => {
    expect(classifyCommandShape("gcloud auth print-access-token")).toBe("secret")
    expect(classifyCommandShape("gcloud auth print-identity-token")).toBe("secret")
  })

  test("gh auth status / token are secret", () => {
    expect(classifyCommandShape("gh auth status")).toBe("secret")
    expect(classifyCommandShape("gh auth token")).toBe("secret")
  })

  test("cat against ~/.env / ~/.aws / ~/.ssh/id_* is secret", () => {
    expect(classifyCommandShape("cat ~/.env")).toBe("secret")
    expect(classifyCommandShape("cat ~/.aws/credentials")).toBe("secret")
    expect(classifyCommandShape("cat ~/.ssh/id_rsa")).toBe("secret")
  })

  test("file readers treat ADR glob forms ~/.env* and ~/.aws/* as secret", () => {
    expect(classifyCommandShape("cat ~/.env*")).toBe("secret")
    expect(classifyCommandShape("head /repo/.env*")).toBe("secret")
    expect(classifyCommandShape("less ~/.aws/*")).toBe("secret")
    expect(classifyCommandShape("tail -n 1 ~/.env*")).toBe("secret")
  })

  test("cat against a normal file is public", () => {
    expect(classifyCommandShape("cat /repo/src/index.ts")).toBe("public")
    expect(classifyCommandShape("cat README.md")).toBe("public")
  })

  test("pagers / dumpers against a secret path are also secret", () => {
    expect(classifyCommandShape("head ~/.ssh/id_rsa")).toBe("secret")
    expect(classifyCommandShape("tail ~/.netrc")).toBe("secret")
    expect(classifyCommandShape("less ~/.aws/credentials")).toBe("secret")
    expect(classifyCommandShape("xxd ~/.ssh/id_ed25519")).toBe("secret")
    expect(classifyCommandShape("strings /etc/ssl/private.pem")).toBe("secret")
  })

  test("pagers against a normal file are public", () => {
    expect(classifyCommandShape("head /repo/src/index.ts")).toBe("public")
    expect(classifyCommandShape("less README.md")).toBe("public")
  })

  test("glob handling stays structural, not fuzzy", () => {
    expect(classifyCommandShape("cat ~/.envrc")).toBe("public")
    expect(classifyCommandShape("cat ~/.env-backup")).toBe("public")
    expect(classifyCommandShape("cat ~/.awsome/*")).toBe("public")
  })

  test("password manager CLIs are secret", () => {
    expect(classifyCommandShape("keychain")).toBe("secret")
    expect(classifyCommandShape("pass show github")).toBe("secret")
    expect(classifyCommandShape("op read 'op://Personal/MyKey/password'")).toBe("secret")
    expect(classifyCommandShape("security find-generic-password -s svc")).toBe("secret")
  })

  // aug-23 audit — RELATIVE secret paths. `isSecretReaderPathArg` gated on a
  // `/` or `~/` prefix, so the MOST COMMON shape an agent actually types —
  // `cat .env` from the repo root — classified `public` and Layer-1's
  // whole-output substitution never fired. `classifyPath` itself already
  // answers `secret` for a bare `.env`; only the command-shape gate was
  // dropping it on the floor.
  test("relative secret paths are secret (the common shape, not just ~/ and /)", () => {
    expect(classifyCommandShape("cat .env")).toBe("secret")
    expect(classifyCommandShape("cat ./.env")).toBe("secret")
    expect(classifyCommandShape("cat .env.local")).toBe("secret")
    expect(classifyCommandShape("head -n 5 config/.env")).toBe("secret")
    expect(classifyCommandShape("cat .ssh/id_rsa")).toBe("secret")
  })

  // PAIRED CONTROL for the widening above — a relative arg must not turn every
  // ordinary read into `secret`. Without this the fix could pass by classifying
  // everything, which would blank out normal tool output.
  test("relative ORDINARY paths stay public (the widening is bounded)", () => {
    expect(classifyCommandShape("cat package.json")).toBe("public")
    expect(classifyCommandShape("cat src/index.ts")).toBe("public")
    expect(classifyCommandShape("head -n 20 README.md")).toBe("public")
    expect(classifyCommandShape("cat .gitignore")).toBe("public")
    expect(classifyCommandShape("cat .envrc")).toBe("public")
  })

  test("empty / unrelated command is public", () => {
    expect(classifyCommandShape("")).toBe("public")
    expect(classifyCommandShape("ls -la")).toBe("public")
    expect(classifyCommandShape("git status")).toBe("public")
  })

  // T1 — one-level shell -c/-lc unwrap. The first token of `bash -c 'printenv'`
  // is `bash`, so a head-only classifier treated credential dumps as public and
  // Layer-1 never substituted the whole output. Bounded: only bash/sh + -c/-lc,
  // payload reclassified once. Paired controls keep benign wrappers public.
  test("bash/sh -c credential printers unwrap to secret", () => {
    expect(classifyCommandShape("bash -c 'printenv'")).toBe("secret")
    expect(classifyCommandShape("sh -c 'gh auth token'")).toBe("secret")
    expect(classifyCommandShape("bash -lc 'gcloud auth print-access-token'")).toBe("secret")
  })

  test("bash -c of a benign command stays public", () => {
    expect(classifyCommandShape("bash -c 'ls -la'")).toBe("public")
  })

  test("nested shell wrappers cannot hide a credential-printing command", () => {
    expect(classifyCommandShape(`bash -c "bash -c 'printenv'"`)).toBe("secret")
    expect(classifyCommandShape(`sh -lc "bash -c 'gh auth token'"`)).toBe("secret")
  })

  test("interpreter eval that reads environment or .env is secret", () => {
    expect(classifyCommandShape(`node -e 'console.log(process.env)'`)).toBe("secret")
    expect(classifyCommandShape(`python -c 'print(os.environ)'`)).toBe("secret")
    expect(classifyCommandShape(`node -e 'require("fs").readFileSync(".env")'`)).toBe("secret")
  })

  test("benign interpreter eval remains public", () => {
    expect(classifyCommandShape(`node -e 'console.log(1 + 1)'`)).toBe("public")
    expect(classifyCommandShape(`python -c 'print(2 + 2)'`)).toBe("public")
  })

  test("bash script.sh without -c keeps the existing public classification", () => {
    expect(classifyCommandShape("bash script.sh")).toBe("public")
  })
})

describe("classifyCodeShape — host runtime eval", () => {
  test("environment and secret-path reads are secret", () => {
    expect(classifyCodeShape("console.log(process.env.ANTHROPIC_API_KEY)")).toBe("secret")
    expect(classifyCodeShape("console.log(import.meta.env.ANTHROPIC_API_KEY)")).toBe("secret")
    expect(classifyCodeShape(`require("fs").readFileSync(".env", "utf8")`)).toBe("secret")
    expect(classifyCodeShape(`require("child_process").execSync("gh auth token")`)).toBe("secret")
  })

  test("dynamic file-read paths fail closed", () => {
    expect(classifyCodeShape("require('fs').readFileSync(userPath, 'utf8')")).toBe("secret")
    expect(classifyCodeShape("require('fs').readFileSync(`" + "$" + "{root}/token`)")).toBe(
      "secret",
    )
    expect(classifyCodeShape("require('fs').readFileSync('package.json', 'utf8')")).toBe("public")
  })

  test("ordinary computation remains public", () => {
    expect(classifyCodeShape("const answer = 40 + 2; answer")).toBe("public")
  })
})
