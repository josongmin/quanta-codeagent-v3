// Pure unit tests for the JSON wire shapes. No ScreenCaptureKit / Vision /
// AppKit dependency — these tests can run in any Swift toolchain, on or off
// macOS, which keeps `swift test` cheap.
//
// What we lock here is the SHAPE of stdout JSON: snake_case key spellings, key
// order being whatever JSONEncoder gives us (we only assert presence + value
// round-trip, not byte-equality), and the closed-enum rawValue for ErrorCode.
//
import Foundation
import XCTest
@testable import ScreenOcr

final class ModelsTests: XCTestCase {
    // MARK: helpers

    private func roundTrip<T: Codable & Equatable>(_ value: T, file: StaticString = #file, line: UInt = #line) throws -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        let decoded = try JSONDecoder().decode(T.self, from: data)
        XCTAssertEqual(value, decoded, "round-trip equality", file: file, line: line)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("expected top-level object", file: file, line: line)
            return [:]
        }
        return dict
    }

    // MARK: ListWindowsResponse

    func testListWindowsRoundTripAndKeys() throws {
        let resp = ListWindowsResponse(windows: [
            WindowInfo(
                id: 1234,
                app: "Safari",
                title: "Some page",
                bounds: PixelBounds(x: 0, y: 0, w: 1280, h: 800),
                layer: 0
            ),
        ])
        let dict = try roundTrip(resp)
        XCTAssertNotNil(dict["windows"], "top-level `windows` key present")
        guard let windows = dict["windows"] as? [[String: Any]], let first = windows.first else {
            XCTFail("windows[] missing or empty"); return
        }
        XCTAssertEqual(first["id"] as? Int, 1234)
        XCTAssertEqual(first["app"] as? String, "Safari")
        XCTAssertEqual(first["title"] as? String, "Some page")
        XCTAssertEqual(first["layer"] as? Int, 0)
        guard let bounds = first["bounds"] as? [String: Any] else {
            XCTFail("bounds object missing"); return
        }
        XCTAssertEqual(bounds["x"] as? Int, 0)
        XCTAssertEqual(bounds["w"] as? Int, 1280)
    }

    // MARK: CaptureResponse snake_case

    func testCaptureResponseSnakeCaseKeys() throws {
        let resp = CaptureResponse(
            windowId: 1234,
            capturedAtMs: 1_716_200_000_000,
            imageSize: ImageSize(w: 1280, h: 800),
            text: "Hello\nworld",
            lines: [
                OcrLine(
                    text: "Hello",
                    bbox: NormalizedBBox(x: 0.1, y: 0.2, w: 0.3, h: 0.05),
                    confidence: 0.98
                ),
            ],
            imagePngB64: nil
        )
        let dict = try roundTrip(resp)
        // All multi-word keys snake_case (matches quanta's wire convention).
        XCTAssertNotNil(dict["window_id"], "window_id snake_case")
        XCTAssertNotNil(dict["captured_at_ms"], "captured_at_ms snake_case")
        XCTAssertNotNil(dict["image_size"], "image_size snake_case")
        // image_png_b64 is present as JSON `null` (NOT missing) so the host
        // can distinguish "no image requested" from "field absent".
        XCTAssertTrue(dict.keys.contains("image_png_b64"), "image_png_b64 key present even when null")
        XCTAssertTrue(dict["image_png_b64"] is NSNull, "image_png_b64 is JSON null when not requested")
        XCTAssertNil(dict["windowId"], "camelCase windowId MUST NOT appear")
        XCTAssertNil(dict["imagePngB64"], "camelCase imagePngB64 MUST NOT appear")
    }

    func testCaptureResponseWithImageBase64() throws {
        let png = Data([0x89, 0x50, 0x4e, 0x47]).base64EncodedString() // "‰PNG" header bytes
        let resp = CaptureResponse(
            windowId: 1,
            capturedAtMs: 0,
            imageSize: ImageSize(w: 1, h: 1),
            text: "",
            lines: [],
            imagePngB64: png
        )
        let dict = try roundTrip(resp)
        XCTAssertEqual(dict["image_png_b64"] as? String, png)
    }

    // MARK: PermissionResponse

    func testPermissionResponseSnakeCase() throws {
        let resp = PermissionResponse(granted: false, needsPrompt: true)
        let dict = try roundTrip(resp)
        XCTAssertEqual(dict["granted"] as? Bool, false)
        XCTAssertEqual(dict["needs_prompt"] as? Bool, true)
        XCTAssertNil(dict["needsPrompt"], "camelCase MUST NOT appear")
    }

    // MARK: ErrorResponse

    func testErrorResponseRawValues() throws {
        let cases: [(ErrorCode, String)] = [
            (.permissionDenied, "PERMISSION_DENIED"),
            (.windowNotFound, "WINDOW_NOT_FOUND"),
            (.captureFailed, "CAPTURE_FAILED"),
            (.ocrFailed, "OCR_FAILED"),
            (.invalidArgs, "INVALID_ARGS"),
            (.unknown, "UNKNOWN"),
        ]
        for (code, rawWire) in cases {
            let env = ErrorResponse.make(code, "msg-\(rawWire)")
            let dict = try roundTrip(env)
            guard let err = dict["error"] as? [String: Any] else {
                XCTFail("error envelope missing for \(rawWire)"); continue
            }
            XCTAssertEqual(err["code"] as? String, rawWire,
                           "code rawValue matches wire string for \(rawWire)")
            XCTAssertEqual(err["message"] as? String, "msg-\(rawWire)")
        }
    }

    // MARK: OcrLine bbox + reading-order sort

    func testOcrLineNormalizedBBoxRoundTrip() throws {
        let line = OcrLine(
            text: "Hello",
            bbox: NormalizedBBox(x: 0.1, y: 0.2, w: 0.3, h: 0.05),
            confidence: 0.98
        )
        let dict = try roundTrip(line)
        guard let bbox = dict["bbox"] as? [String: Any] else {
            XCTFail("bbox missing"); return
        }
        XCTAssertEqual(bbox["x"] as? Double, 0.1)
        XCTAssertEqual(bbox["y"] as? Double, 0.2)
        XCTAssertEqual(dict["confidence"] as? Double, 0.98)
    }

    func testReadingOrderSortTopToBottomLeftToRight() {
        // Two lines on the same y-band (within 0.01 tolerance) should sort by x,
        // and a line further down should come AFTER both.
        let a = OcrLine(text: "right-of-pair",
                        bbox: NormalizedBBox(x: 0.6, y: 0.10, w: 0.1, h: 0.05),
                        confidence: 1.0)
        let b = OcrLine(text: "left-of-pair",
                        bbox: NormalizedBBox(x: 0.1, y: 0.105, w: 0.1, h: 0.05),
                        confidence: 1.0)
        let c = OcrLine(text: "below-both",
                        bbox: NormalizedBBox(x: 0.4, y: 0.50, w: 0.1, h: 0.05),
                        confidence: 1.0)
        let sorted = VisionOCR.sortReadingOrder([a, c, b])
        XCTAssertEqual(sorted.map(\.text), ["left-of-pair", "right-of-pair", "below-both"])
    }

    // MARK: Version

    func testVersionResponse() throws {
        let resp = VersionResponse(version: screenOcrVersion)
        let dict = try roundTrip(resp)
        XCTAssertEqual(dict["version"] as? String, screenOcrVersion)
    }
}
