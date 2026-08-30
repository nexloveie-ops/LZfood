import Foundation

enum WidgetSettingsKeys {
    static let appGroup = "group.com.nexloveie.lzfood.widget"
    static let baseURL = "lzfood.widget.baseURL"
    static let apiKey = "lzfood.widget.apiKey"
    static let dateMode = "lzfood.widget.dateMode"
    static let customDateYmd = "lzfood.widget.customDateYmd"
    static let defaultBaseURL = WidgetLocalDefaults.baseURL
}

private struct WidgetSharedConfig: Codable {
    var baseURL: String?
    var apiKey: String?
    var dateMode: String?
    var customDateYmd: String?
}

enum WidgetSettingsStore {
    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: WidgetSettingsKeys.appGroup)
    }

    /** App 与 Widget 扩展能否通过 App Group 共享配置 */
    static var appGroupAvailable: Bool {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetSettingsKeys.appGroup) != nil
    }

    private static var configFileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: WidgetSettingsKeys.appGroup)?
            .appendingPathComponent("widget-config.json")
    }

    private static func loadFileConfig() -> WidgetSharedConfig {
        guard let url = configFileURL,
              let data = try? Data(contentsOf: url),
              let cfg = try? JSONDecoder().decode(WidgetSharedConfig.self, from: data) else {
            return WidgetSharedConfig()
        }
        return cfg
    }

    private static func saveFileConfig(_ cfg: WidgetSharedConfig) {
        guard let url = configFileURL else { return }
        guard let data = try? JSONEncoder().encode(cfg) else { return }
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    /** App 保存时：UserDefaults + App Group 文件双写，确保 Widget 扩展能读到 */
    static func persistAll(
        baseURL: String,
        apiKey: String,
        dateMode: WidgetDateMode,
        customDateYmd: String,
    ) {
        let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBase = baseURL.trimmingSuffix("/")

        defaults?.set(trimmedBase, forKey: WidgetSettingsKeys.baseURL)
        defaults?.set(trimmedKey, forKey: WidgetSettingsKeys.apiKey)
        defaults?.set(dateMode.rawValue, forKey: WidgetSettingsKeys.dateMode)
        defaults?.set(customDateYmd, forKey: WidgetSettingsKeys.customDateYmd)
        defaults?.synchronize()

        saveFileConfig(WidgetSharedConfig(
            baseURL: trimmedBase,
            apiKey: trimmedKey.isEmpty ? nil : trimmedKey,
            dateMode: dateMode.rawValue,
            customDateYmd: customDateYmd,
        ))
    }

    static var baseURL: String {
        get {
            let file = loadFileConfig().baseURL?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let file, !file.isEmpty { return file.trimmingSuffix("/") }
            let raw = defaults?.string(forKey: WidgetSettingsKeys.baseURL)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let raw, !raw.isEmpty { return raw.trimmingSuffix("/") }
            return WidgetSettingsKeys.defaultBaseURL
        }
        set {
            defaults?.set(newValue.trimmingSuffix("/"), forKey: WidgetSettingsKeys.baseURL)
        }
    }

    static var apiKey: String {
        get {
            let file = loadFileConfig().apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !file.isEmpty { return file }
            let raw = defaults?.string(forKey: WidgetSettingsKeys.apiKey)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !raw.isEmpty { return raw }
            return WidgetLocalDefaults.apiKey
        }
        set { defaults?.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: WidgetSettingsKeys.apiKey) }
    }

    static var isConfigured: Bool {
        !apiKey.isEmpty && apiKey.hasPrefix("lzf_live_")
    }

    static var dateMode: WidgetDateMode {
        get {
            if let raw = loadFileConfig().dateMode, let m = WidgetDateMode(rawValue: raw) { return m }
            if let raw = defaults?.string(forKey: WidgetSettingsKeys.dateMode),
               let m = WidgetDateMode(rawValue: raw) { return m }
            return WidgetLocalDefaults.dateMode
        }
        set { defaults?.set(newValue.rawValue, forKey: WidgetSettingsKeys.dateMode) }
    }

    static var customDateYmd: String {
        get {
            if let file = loadFileConfig().customDateYmd, !file.isEmpty { return file }
            if let raw = defaults?.string(forKey: WidgetSettingsKeys.customDateYmd), !raw.isEmpty { return raw }
            return WidgetLocalDefaults.customDateYmd
        }
        set { defaults?.set(newValue, forKey: WidgetSettingsKeys.customDateYmd) }
    }

    static var customDate: Date {
        get { WidgetReportDate.date(fromYmd: customDateYmd) ?? Date() }
        set { customDateYmd = WidgetReportDate.ymdString(from: newValue) }
    }

    static var reportDateYmd: String {
        switch dateMode {
        case .today:
            return WidgetReportDate.dublinTodayYmd()
        case .custom:
            return customDateYmd
        }
    }
}

private extension String {
    func trimmingSuffix(_ suffix: String) -> String {
        hasSuffix(suffix) ? String(dropLast(suffix.count)) : self
    }
}
