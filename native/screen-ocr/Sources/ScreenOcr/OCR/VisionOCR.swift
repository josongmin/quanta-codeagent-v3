// Vision OCR wrapper.
//
// Single function: `recognize(in:)` runs VNRecognizeTextRequest revision 3 on
// a CGImage with the language set we care about (Korean + English) and returns
// a normalized (origin top-left) line list sorted top-to-bottom, left-to-right.
//
// Why we y-flip: Vision reports bounding boxes in the [0..1] coordinate space
// with the origin at the BOTTOM-left (Quartz convention). Every other quanta
// surface expects normalized coords with the origin at the TOP-left, so we
// translate here once at the boundary instead of pushing that gotcha downstream.
//
import CoreGraphics
import Foundation
import Vision

enum OCRError: Error {
    case requestFailed(String)
}

@available(macOS 13.0, *)
enum VisionOCR {
    /// Run text recognition over the given image. Returns lines sorted
    /// top-to-bottom, left-to-right with normalized top-left-origin bboxes.
    static func recognize(in image: CGImage) throws -> [OcrLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["ko-KR", "en-US"]
        request.revision = VNRecognizeTextRequestRevision3

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw OCRError.requestFailed(error.localizedDescription)
        }

        let observations = request.results ?? []
        var lines: [OcrLine] = []
        lines.reserveCapacity(observations.count)

        for obs in observations {
            guard let top = obs.topCandidates(1).first else { continue }
            // Vision bbox is bottom-left-origin in [0..1]. Flip to top-left.
            let v = obs.boundingBox
            let flipped = NormalizedBBox(
                x: Double(v.origin.x),
                y: Double(1.0 - v.origin.y - v.size.height),
                w: Double(v.size.width),
                h: Double(v.size.height)
            )
            lines.append(OcrLine(
                text: top.string,
                bbox: flipped,
                confidence: Double(top.confidence)
            ))
        }

        return sortReadingOrder(lines)
    }

    /// Stable reading-order sort: primary key y (top→bottom), secondary x
    /// (left→right). Tolerance on y keeps a single line of mixed-height glyphs
    /// from getting fragmented across rows.
    static func sortReadingOrder(_ lines: [OcrLine]) -> [OcrLine] {
        let tol = 0.01
        return lines.sorted { a, b in
            if abs(a.bbox.y - b.bbox.y) < tol {
                return a.bbox.x < b.bbox.x
            }
            return a.bbox.y < b.bbox.y
        }
    }
}
