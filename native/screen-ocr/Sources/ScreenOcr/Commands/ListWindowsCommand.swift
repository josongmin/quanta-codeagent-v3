// `screen-ocr list-windows` — print enumerable on-screen windows as JSON.
//
// This subcommand intentionally does NOT require Screen Recording permission;
// CGWindowListCopyWindowInfo lists windows regardless. Titles MAY be redacted
// by the OS until permission is granted — that's a user-visible signal, not an
// error condition.
//
import ArgumentParser
import Foundation

struct ListWindowsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "list-windows",
        abstract: "List on-screen windows as JSON."
    )

    func run() throws {
        let resp = WindowEnumerator.enumerate()
        Output.printJSON(resp)
    }
}
