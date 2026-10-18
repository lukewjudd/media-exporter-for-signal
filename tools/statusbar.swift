// Reads image paths on stdin (one per line) and prints one JSON line per image:
//   top       text in the top strip, where a phone screenshot's status bar (clock, battery) sits
//   coverage  fraction of the image covered by recognised text
//   chars     number of recognised characters
// Uses Apple's Vision framework (on-device). Used by clip.mjs to catch screenshots CLIP misses.
import Foundation
import ImageIO
import Vision

let stripOfWidth = 0.14 // status bars are ~6-12% of the screen width tall

func recognise(_ image: CGImage, level: VNRequestTextRecognitionLevel) -> [VNRecognizedTextObservation] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = level
  request.usesLanguageCorrection = false
  try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  return request.results ?? []
}

while let path = readLine() {
  var result: [String: Any] = ["path": path, "top": "", "coverage": 0, "chars": 0]
  if let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
     let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
    let height = min(image.height, Int(Double(image.width) * stripOfWidth))
    if let strip = image.cropping(to: CGRect(x: 0, y: 0, width: image.width, height: height)) {
      result["top"] = recognise(strip, level: .accurate).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    }
    // Ignore stray one- or two-character hits on textures and faces
    let lines = recognise(image, level: .fast).filter { ($0.topCandidates(1).first.map { $0.confidence >= 0.4 && $0.string.count >= 3 }) ?? false }
    result["coverage"] = lines.reduce(0.0) { $0 + Double($1.boundingBox.width * $1.boundingBox.height) }
    result["chars"] = lines.reduce(0) { $0 + ($1.topCandidates(1).first?.string.count ?? 0) }
  }
  if let data = try? JSONSerialization.data(withJSONObject: result), let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}
