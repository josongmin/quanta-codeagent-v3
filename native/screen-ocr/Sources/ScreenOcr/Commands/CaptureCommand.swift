// `screen-ocr capture --window-id N [--include-image]` — single-frame capture
// + Vision OCR, JSON to stdout.
//
// Failure paths map onto the closed ErrorCode enum + a non-zero exit code:
//   PERMISSION_DENIED  -> 3
//   WINDOW_NOT_FOUND   -> 4
//   CAPTURE_FAILED     -> 5
//   OCR_FAILED         -> 5
//   UNKNOWN            -> 1
//
import ArgumentParser
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct CaptureCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "capture",
        abstract: "Capture one frame of a window and OCR it."
    )

    @Option(name: .customLong("window-id"), help: "The CGWindowID of the target window (see `list-windows`).")
    var windowId: UInt32

    @Flag(name: .customLong("include-image"), help: "Embed the captured frame as base64 PNG in the response.")
    var includeImage: Bool = false

    func run() async throws {
        guard #available(macOS 13.0, *) else {
            Output.printError(.captureFailed, "macOS 13.0 or later required")
            throw ExitCode(5)
        }
        do {
            try await runCapture()
        } catch let err as CaptureError {
            throw ExitCode(handleCaptureError(err))
        } catch let err as OCRError {
            if case .requestFailed(let msg) = err {
                Output.printError(.ocrFailed, msg)
            }
            throw ExitCode(5)
        } catch let err as ExitCode {
            throw err
        } catch {
            Output.printError(.unknown, "unexpected: \(error.localizedDescription)")
            throw ExitCode(1)
        }
    }

    @available(macOS 13.0, *)
    private func runCapture() async throws {
        let cgWindowId = CGWindowID(windowId)
        let capture = ScreenCapture()
        let image = try await capture.grab(windowId: cgWindowId)
        let lines = try VisionOCR.recognize(in: image)
        let concatenated = lines.map(\.text).joined(separator: "\n")
        let pngB64 = includeImage ? Self.encodePngBase64(image) : nil
        let resp = CaptureResponse(
            windowId: Int(cgWindowId),
            capturedAtMs: Int64(Date().timeIntervalSince1970 * 1000.0),
            imageSize: ImageSize(w: image.width, h: image.height),
            text: concatenated,
            lines: lines,
            imagePngB64: pngB64
        )
        Output.printJSON(resp)
    }

    private func handleCaptureError(_ err: CaptureError) -> Int32 {
        switch err {
        case .permissionDenied(let msg):
            Output.printError(.permissionDenied, msg)
            return 3
        case .windowNotFound(let id):
            Output.printError(.windowNotFound, "no on-screen window with id \(id)")
            return 4
        case .captureFailed(let msg):
            Output.printError(.captureFailed, msg)
            return 5
        }
    }

    /// PNG encode + base64. Returns nil on any encode failure (the caller
    /// records that as a missing field, not a hard error — we'd rather emit
    /// the OCR result than throw away the whole capture).
    static func encodePngBase64(_ image: CGImage) -> String? {
        let data = NSMutableData()
        let utType: CFString
        if #available(macOS 11.0, *) {
            utType = UTType.png.identifier as CFString
        } else {
            // Falls back to the legacy UTI string on theoretical older systems
            // — Package.swift pins to 13.0+, so this branch is dead in practice.
            utType = "public.png" as CFString
        }
        guard let dest = CGImageDestinationCreateWithData(data, utType, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            return nil
        }
        return (data as Data).base64EncodedString()
    }
}
