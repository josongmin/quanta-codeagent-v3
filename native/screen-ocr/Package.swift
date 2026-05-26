// swift-tools-version:5.9
//
// quanta-codeagent-v3 screen-ocr sidecar — see docs/decisions/0318-screen-ocr-native-sidecar.md
//
// Single executable target (`screen-ocr`) plus a pure unit-test bundle for
// the JSON wire shapes. Mac-only by design; iOS/UIKit imports are forbidden.
//
import PackageDescription

let package = Package(
    name: "screen-ocr",
    platforms: [
        // ScreenCaptureKit shipped in macOS 12.3 but the .accurate-revision-3
        // Vision text recognizer + several SC* stability fixes land in 13.0,
        // so we pin to 13.0 to keep the sidecar simple.
        .macOS(.v13),
    ],
    products: [
        .executable(name: "screen-ocr", targets: ["ScreenOcr"]),
    ],
    dependencies: [
        // ArgumentParser is the de-facto Swift subcommand router.
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.3.0"),
    ],
    targets: [
        .executableTarget(
            name: "ScreenOcr",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/ScreenOcr"
        ),
        .testTarget(
            name: "ScreenOcrTests",
            dependencies: ["ScreenOcr"],
            path: "Tests/ScreenOcrTests"
        ),
    ]
)
