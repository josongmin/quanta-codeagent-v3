// screen-ocr — quanta Tauri-shell native sidecar.
//
// See `docs/decisions/0318-screen-ocr-native-sidecar.md` for the why.
//
// Exit code table:
//   0  success
//   1  unknown / unexpected error
//   2  invalid CLI args (ArgumentParser default)
//   3  permission denied (TCC Screen Recording)
//   4  window not found
//   5  capture / OCR failure
//
import ArgumentParser
import Foundation

@main
struct ScreenOcr: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "screen-ocr",
        abstract: "quanta sidecar — list windows + capture + OCR via ScreenCaptureKit + Vision.",
        version: screenOcrVersion,
        subcommands: [
            ListWindowsCommand.self,
            CaptureCommand.self,
            CheckPermissionCommand.self,
        ]
    )
}

struct CheckPermissionCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "check-permission",
        abstract: "Probe (do not prompt) the TCC Screen Recording state."
    )

    func run() throws {
        guard #available(macOS 13.0, *) else {
            Output.printError(.permissionDenied, "macOS 13.0 or later required")
            throw ExitCode(3)
        }
        let resp = ScreenRecordingPermission.probe()
        Output.printJSON(resp)
    }
}
