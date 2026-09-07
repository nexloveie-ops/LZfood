import Foundation

struct WidgetStoreProfile: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var label: String
    var apiKey: String

    init(id: String = UUID().uuidString, label: String, apiKey: String) {
        self.id = id
        self.label = label
        self.apiKey = apiKey
    }

    var trimmedLabel: String {
        label.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var trimmedApiKey: String {
        apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var isValidKey: Bool {
        trimmedApiKey.hasPrefix("lzf_live_")
    }

    var displayLabel: String {
        let t = trimmedLabel
        return t.isEmpty ? "未命名店铺" : t
    }
}

enum WidgetStoreProfiles {
    static let maxCount = 4
}
