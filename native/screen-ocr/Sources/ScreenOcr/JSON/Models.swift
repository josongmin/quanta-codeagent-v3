// JSON wire shapes for the screen-ocr sidecar.
//
// All keys are snake_case (to match the rest of quanta's wire format). The
// `*Response` types are what gets printed; the `*Error` envelope is what gets
// printed on the failure path (and a non-zero exit code follows).
//
// Pure value types — no system framework dependency, so they're exercised by
// `Tests/ScreenOcrTests/ModelsTests.swift` without ScreenCaptureKit/Vision.
//
import Foundation

// MARK: - Geometry

/// Pixel-space rect for window enumeration output (integer pixels).
public struct PixelBounds: Codable, Equatable, Sendable {
    public let x: Int
    public let y: Int
    public let w: Int
    public let h: Int

    public init(x: Int, y: Int, w: Int, h: Int) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

/// Image-relative pixel size (width × height in pixels).
public struct ImageSize: Codable, Equatable, Sendable {
    public let w: Int
    public let h: Int

    public init(w: Int, h: Int) {
        self.w = w
        self.h = h
    }
}

/// Normalized OCR bounding box (0..1 origin top-left).
public struct NormalizedBBox: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let w: Double
    public let h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

// MARK: - list-windows

public struct WindowInfo: Codable, Equatable, Sendable {
    public let id: Int
    public let app: String
    public let title: String
    public let bounds: PixelBounds
    public let layer: Int

    public init(id: Int, app: String, title: String, bounds: PixelBounds, layer: Int) {
        self.id = id
        self.app = app
        self.title = title
        self.bounds = bounds
        self.layer = layer
    }
}

public struct ListWindowsResponse: Codable, Equatable, Sendable {
    public let windows: [WindowInfo]

    public init(windows: [WindowInfo]) {
        self.windows = windows
    }
}

// MARK: - capture

public struct OcrLine: Codable, Equatable, Sendable {
    public let text: String
    public let bbox: NormalizedBBox
    public let confidence: Double

    public init(text: String, bbox: NormalizedBBox, confidence: Double) {
        self.text = text
        self.bbox = bbox
        self.confidence = confidence
    }
}

public struct CaptureResponse: Codable, Equatable, Sendable {
    public let windowId: Int
    public let capturedAtMs: Int64
    public let imageSize: ImageSize
    public let text: String
    public let lines: [OcrLine]
    /// PNG bytes base64-encoded, or nil when `--include-image` is not passed.
    /// Emitted as JSON `null` (NOT omitted) — see `encode(to:)` below.
    public let imagePngB64: String?

    enum CodingKeys: String, CodingKey {
        case windowId = "window_id"
        case capturedAtMs = "captured_at_ms"
        case imageSize = "image_size"
        case text
        case lines
        case imagePngB64 = "image_png_b64"
    }

    public init(
        windowId: Int,
        capturedAtMs: Int64,
        imageSize: ImageSize,
        text: String,
        lines: [OcrLine],
        imagePngB64: String?
    ) {
        self.windowId = windowId
        self.capturedAtMs = capturedAtMs
        self.imageSize = imageSize
        self.text = text
        self.lines = lines
        self.imagePngB64 = imagePngB64
    }

    // Hand-rolled encode so a nil `imagePngB64` becomes JSON `null` (not omitted).
    // The host parser distinguishes "field absent" (protocol error) from
    // "field present, no image embedded" (normal — `--include-image` was off).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(windowId, forKey: .windowId)
        try c.encode(capturedAtMs, forKey: .capturedAtMs)
        try c.encode(imageSize, forKey: .imageSize)
        try c.encode(text, forKey: .text)
        try c.encode(lines, forKey: .lines)
        if let b64 = imagePngB64 {
            try c.encode(b64, forKey: .imagePngB64)
        } else {
            try c.encodeNil(forKey: .imagePngB64)
        }
    }
}

// MARK: - check-permission

public struct PermissionResponse: Codable, Equatable, Sendable {
    public let granted: Bool
    public let needsPrompt: Bool

    enum CodingKeys: String, CodingKey {
        case granted
        case needsPrompt = "needs_prompt"
    }

    public init(granted: Bool, needsPrompt: Bool) {
        self.granted = granted
        self.needsPrompt = needsPrompt
    }
}

// MARK: - error envelope

/// Closed enum of error categories the sidecar can emit. Wire is the rawValue.
public enum ErrorCode: String, Codable, Equatable, Sendable {
    case permissionDenied = "PERMISSION_DENIED"
    case windowNotFound = "WINDOW_NOT_FOUND"
    case captureFailed = "CAPTURE_FAILED"
    case ocrFailed = "OCR_FAILED"
    case invalidArgs = "INVALID_ARGS"
    case unknown = "UNKNOWN"
}

public struct ErrorPayload: Codable, Equatable, Sendable {
    public let code: ErrorCode
    public let message: String

    public init(code: ErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}

public struct ErrorResponse: Codable, Equatable, Sendable {
    public let error: ErrorPayload

    public init(error: ErrorPayload) {
        self.error = error
    }

    public static func make(_ code: ErrorCode, _ message: String) -> ErrorResponse {
        ErrorResponse(error: ErrorPayload(code: code, message: message))
    }
}

// MARK: - version

public struct VersionResponse: Codable, Equatable, Sendable {
    public let version: String

    public init(version: String) {
        self.version = version
    }
}

/// Compile-time version string. Bumped per release.
public let screenOcrVersion = "0.1.0"
