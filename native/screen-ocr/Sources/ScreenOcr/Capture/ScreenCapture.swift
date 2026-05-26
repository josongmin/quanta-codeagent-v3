// Single-frame ScreenCaptureKit grab.
//
// SCStream is a streaming API; we want one frame and then stop. We register a
// SCStreamOutput handler that resolves the first CMSampleBuffer with a CGImage
// and then immediately stops the stream. Everything is funnelled through a
// continuation so the public API is `func grab() async throws -> CGImage`.
//
// macOS 13.0+ ONLY (the whole Sources tree is gated on that platform pin in
// Package.swift, but we still annotate the class as a defensive measure).
//
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// Typed failure surface so CaptureCommand can map onto the ErrorCode enum.
enum CaptureError: Error {
    case permissionDenied(String)
    case windowNotFound(CGWindowID)
    case captureFailed(String)
}

@available(macOS 13.0, *)
final class ScreenCapture: NSObject, @unchecked Sendable {
    // MARK: - Public

    /// Grab one frame from the window with the given CGWindowID.
    ///
    /// Throws `CaptureError` on every failure path; the caller (CaptureCommand)
    /// maps that onto the JSON error envelope + exit code.
    func grab(windowId: CGWindowID, timeout: TimeInterval = 5.0) async throws -> CGImage {
        let target = try await resolveWindow(windowId: windowId)
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let config = makeConfig(for: target)

        return try await withFrameStream(filter: filter, config: config, timeout: timeout)
    }

    // MARK: - Internal helpers

    private func resolveWindow(windowId: CGWindowID) async throws -> SCWindow {
        let content: SCShareableContent
        do {
            // `excludingDesktopWindows: false, onScreenWindowsOnly: true` —
            // we want any on-screen, regardless of layer; the host already
            // chose the id from our list-windows output.
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
        } catch {
            // The most common error here is "user has not granted screen
            // recording permission". SCK does not expose a discrete error
            // code, so we report by message.
            throw CaptureError.permissionDenied(
                "SCShareableContent failed: \(error.localizedDescription)"
            )
        }

        guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
            throw CaptureError.windowNotFound(windowId)
        }
        return window
    }

    private func makeConfig(for window: SCWindow) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        // BGRA pixel format — matches what Vision is happiest consuming on macOS.
        config.pixelFormat = kCVPixelFormatType_32BGRA
        // Match the window's intrinsic pixel size when we can. Falling back to
        // the bounds.width when SCK is conservative.
        let w = Int(window.frame.size.width)
        let h = Int(window.frame.size.height)
        if w > 0 && h > 0 {
            config.width = w
            config.height = h
        }
        config.showsCursor = false
        // `minimumFrameInterval` controls cadence; we only take one frame and
        // stop, but a higher cadence reduces wait until the first sample.
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        if #available(macOS 14.0, *) {
            config.captureResolution = .best
        }
        return config
    }

    private func withFrameStream(
        filter: SCContentFilter,
        config: SCStreamConfiguration,
        timeout: TimeInterval
    ) async throws -> CGImage {
        // Single-shot continuation guarded by a serial queue. We must call it
        // exactly once: either with a frame, an error, or a timeout error.
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let handler = FrameHandler()

        do {
            try stream.addStreamOutput(
                handler,
                type: .screen,
                sampleHandlerQueue: DispatchQueue(label: "screen-ocr.frame.queue")
            )
        } catch {
            throw CaptureError.captureFailed(
                "addStreamOutput failed: \(error.localizedDescription)"
            )
        }

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<CGImage, Error>) in
            // Wire the handler to the continuation BEFORE startCapture so we
            // never miss the first frame.
            handler.onImage = { image in
                Task { [stream] in
                    // Always stop the stream; ignore any stop error.
                    try? await stream.stopCapture()
                }
                cont.resume(returning: image)
            }
            handler.onError = { err in
                Task { [stream] in
                    try? await stream.stopCapture()
                }
                cont.resume(throwing: err)
            }

            stream.startCapture { startError in
                if let startError {
                    handler.fail(.captureFailed(
                        "startCapture failed: \(startError.localizedDescription)"
                    ))
                }
            }

            // Wall-clock timeout: if no frame arrives we fail loud.
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                handler.fail(.captureFailed("timed out waiting for first frame (\(Int(timeout))s)"))
            }
        }
    }
}

// MARK: - SCStreamOutput shim

/// Internal class that funnels SCStreamOutput callbacks into a single-shot
/// (CGImage | Error) result. The serial queue around `state` guarantees that
/// `onImage` / `onError` are called at most once.
@available(macOS 13.0, *)
private final class FrameHandler: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    var onImage: ((CGImage) -> Void)?
    var onError: ((Error) -> Void)?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard CMSampleBufferIsValid(sampleBuffer) else {
            Output.debug("sampleBuffer invalid")
            return
        }
        guard sampleBuffer.imageBuffer != nil else {
            // Some early frames are status-only with no pixel buffer; wait.
            return
        }
        guard let image = cgImage(from: sampleBuffer) else {
            fail(.captureFailed("CGImage conversion failed"))
            return
        }
        fire { self.onImage?(image) }
    }

    func fail(_ err: CaptureError) {
        fire { self.onError?(err) }
    }

    private func fire(_ block: () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        if fired { return }
        fired = true
        block()
    }

    private func cgImage(from sampleBuffer: CMSampleBuffer) -> CGImage? {
        guard let pixelBuffer = sampleBuffer.imageBuffer else { return nil }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let ctx = CIContext(options: nil)
        let rect = CGRect(
            x: 0,
            y: 0,
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer)
        )
        return ctx.createCGImage(ciImage, from: rect)
    }
}
