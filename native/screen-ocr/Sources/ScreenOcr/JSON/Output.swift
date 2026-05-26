// stdout/stderr write helpers — single source of truth for output discipline.
//
// Contract:
//   - stdout: JSON only. Single line. Exactly one trailing `\n`.
//   - stderr: free-form debug, only when SCREEN_OCR_DEBUG=1.
//
import Foundation

enum Output {
    /// Encode `value` as a single-line JSON string and write it to stdout
    /// followed by a single `\n`. Returns true on success.
    @discardableResult
    static func printJSON<T: Encodable>(_ value: T) -> Bool {
        let encoder = JSONEncoder()
        // No .prettyPrinted: parser stability beats human-readability here.
        encoder.outputFormatting = [.withoutEscapingSlashes, .sortedKeys]
        // The defaults (Codable enums with rawValue, Codable structs) already
        // serialise as we want; we just need stable key ordering.
        do {
            let data = try encoder.encode(value)
            guard var line = String(data: data, encoding: .utf8) else {
                debug("printJSON: UTF-8 decode failed")
                return false
            }
            // Defensive: strip any newline an encoder might insert.
            line = line.replacingOccurrences(of: "\n", with: "")
            line += "\n"
            FileHandle.standardOutput.write(Data(line.utf8))
            return true
        } catch {
            debug("printJSON: encode failed: \(error)")
            return false
        }
    }

    /// Print an error envelope to stdout. The exit code is the caller's job.
    static func printError(_ code: ErrorCode, _ message: String) {
        _ = printJSON(ErrorResponse.make(code, message))
    }

    /// Debug log to stderr — silenced unless `SCREEN_OCR_DEBUG=1`.
    static func debug(_ message: @autoclosure () -> String) {
        guard ProcessInfo.processInfo.environment["SCREEN_OCR_DEBUG"] == "1" else {
            return
        }
        let line = "[screen-ocr] " + message() + "\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}
