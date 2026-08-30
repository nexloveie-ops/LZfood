import Foundation

struct WidgetSnapshot: Codable, Sendable {
    let generatedAt: Date
    let timezone: String
    let date: String
    let store: StoreInfo
    let revenue: Revenue
    let payments: Payments
    let segments: Segments

    struct StoreInfo: Codable, Sendable {
        let slug: String
        let displayName: String
        let logoUrl: String?

        init(slug: String, displayName: String, logoUrl: String? = nil) {
            self.slug = slug
            self.displayName = displayName
            self.logoUrl = logoUrl
        }
    }

    struct Revenue: Codable, Sendable {
        let netTotal: Double
        let orderCount: Int
    }

    struct PaymentLine: Codable, Sendable {
        let amount: Double
        let orderCount: Int
    }

    struct Payments: Codable, Sendable {
        let cash: PaymentLine
        let card: PaymentLine
        let online: PaymentLine
    }

    struct SegmentGroup: Codable, Sendable, Identifiable {
        let groupId: String
        let nameZh: String
        let nameEn: String
        let sales: Double
        let orderCount: Int
        let sharePct: Double

        var id: String { groupId }
    }

    enum Segments: Codable, Sendable {
        case disabled
        case enabled(foodTotal: Double, groups: [SegmentGroup])

        private enum CodingKeys: String, CodingKey {
            case enabled, foodTotal, groups
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let enabled = try c.decode(Bool.self, forKey: .enabled)
            if enabled {
                let foodTotal = try c.decode(Double.self, forKey: .foodTotal)
                let groups = try c.decode([SegmentGroup].self, forKey: .groups)
                self = .enabled(foodTotal: foodTotal, groups: groups)
            } else {
                self = .disabled
            }
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .disabled:
                try c.encode(false, forKey: .enabled)
            case let .enabled(foodTotal, groups):
                try c.encode(true, forKey: .enabled)
                try c.encode(foodTotal, forKey: .foodTotal)
                try c.encode(groups, forKey: .groups)
            }
        }

        var isEnabled: Bool {
            if case .enabled = self { return true }
            return false
        }
    }
}

enum SnapshotClientError: LocalizedError, Sendable {
    case notConfigured
    case badURL
    case httpStatus(Int)
    case decodeFailed

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "未配置 API Key"
        case .badURL: return "Base URL 无效"
        case let .httpStatus(code):
            switch code {
            case 401: return "API Key 无效或已撤销"
            case 403: return "Widget API 未开通"
            default: return "服务器错误 (\(code))"
            }
        case .decodeFailed: return "数据解析失败"
        }
    }
}

enum SnapshotClient {
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    static func fetch(
        baseURL: String? = nil,
        apiKey: String? = nil,
        reportDateYmd: String? = nil,
    ) async throws -> WidgetSnapshot {
        let key = apiKey ?? WidgetSettingsStore.apiKey
        guard !key.isEmpty else { throw SnapshotClientError.notConfigured }

        let base = (baseURL ?? WidgetSettingsStore.baseURL).trimmingSuffix("/")
        let ymd = reportDateYmd ?? WidgetSettingsStore.reportDateYmd
        var components = URLComponents(string: "\(base)/api/public/widget-snapshot")
        components?.queryItems = [
            URLQueryItem(name: "date", value: ymd),
        ]
        guard let url = components?.url else {
            throw SnapshotClientError.badURL
        }

        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.httpMethod = "GET"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw SnapshotClientError.httpStatus(-1) }
        guard (200 ... 299).contains(http.statusCode) else {
            throw SnapshotClientError.httpStatus(http.statusCode)
        }
        do {
            return try decoder.decode(WidgetSnapshot.self, from: data)
        } catch {
            throw SnapshotClientError.decodeFailed
        }
    }
}

private extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
    }
}

enum WidgetFormatters {
    static let euro: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "EUR"
        f.maximumFractionDigits = 2
        f.minimumFractionDigits = 2
        return f
    }()

    static let time: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        f.timeZone = TimeZone(identifier: "Europe/Dublin")
        return f
    }()

    static func euroString(_ value: Double) -> String {
        euro.string(from: NSNumber(value: value)) ?? String(format: "€%.2f", value)
    }
}
