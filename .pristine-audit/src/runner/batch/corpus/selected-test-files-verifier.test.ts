import { describe, expect, test } from "bun:test"
import {
  parseSelectedTestFilesToRun,
  selectedTestFilesVerifierCommand,
} from "./selected-test-files-verifier"

describe("selected-test-files verifier synthesis", () => {
  test("go selected test names synthesize a repo-local verifier", () => {
    expect(
      selectedTestFilesVerifierCommand({
        repoLanguage: "go",
        selectedTestFilesToRun: '["TestEvents","TestCore"]',
      }),
    ).toBe("go test -count=1 ./... -run '^(?:TestEvents|TestCore)$'")
  })

  test("go subtest and fuzz selectors with punctuation stay admissible", () => {
    expect(
      selectedTestFilesVerifierCommand({
        repoLanguage: "go",
        selectedTestFilesToRun: [
          "TestParseResourcePath//api/v1/watch/namespaces/kube-system/pods/foo",
          "TestAuthenticate/local_user_and_cluster, no_tunnel",
          "FuzzMongoRead/seed#0",
        ],
      }),
    ).toBe(
      "go test -count=1 ./... -run '^(?:TestParseResourcePath//api/v1/watch/namespaces/kube-system/pods/foo|TestAuthenticate/local_user_and_cluster, no_tunnel|FuzzMongoRead/seed#0)$'",
    )
  })

  test("js/ts selected test file paths synthesize an npm verifier", () => {
    expect(
      selectedTestFilesVerifierCommand({
        repoLanguage: "js",
        selectedTestFilesToRun: ["test/uploads.js", "test/plugins.js"],
      }),
    ).toBe("npm test -- test/uploads.js test/plugins.js")
    expect(
      selectedTestFilesVerifierCommand({
        repoLanguage: "typescript",
        selectedTestFilesToRun: ["src/foo.test.tsx"],
      }),
    ).toBe("npm test -- src/foo.test.tsx")
  })

  test("python stays on the FAIL_TO_PASS path", () => {
    expect(
      selectedTestFilesVerifierCommand({
        repoLanguage: "python",
        selectedTestFilesToRun: ["tests/test_x.py"],
      }),
    ).toBeUndefined()
  })

  test("ambiguous non-python selections fail closed", () => {
    expect(
      selectedTestFilesVerifierCommand({
        repoLanguage: "go",
        selectedTestFilesToRun: ["test/uploads.js"],
      }),
    ).toBeUndefined()
    expect(
      selectedTestFilesVerifierCommand({
        repoLanguage: "js",
        selectedTestFilesToRun: ["TestEvents"],
      }),
    ).toBeUndefined()
  })

  test("parser accepts JSON string arrays and rejects malformed shapes", () => {
    expect(parseSelectedTestFilesToRun('["a","b"]')).toEqual(["a", "b"])
    expect(parseSelectedTestFilesToRun(["a", "b"])).toEqual(["a", "b"])
    expect(parseSelectedTestFilesToRun("not-json")).toBeUndefined()
    expect(parseSelectedTestFilesToRun(["", 1, null])).toBeUndefined()
  })
})
