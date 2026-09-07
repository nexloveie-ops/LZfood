import Foundation

enum WidgetSettingsKeys {
    static let appGroup = "group.com.nexloveie.lzfood.widget"
    static let baseURL = "lzfood.widget.baseURL"
    static let apiKey = "lzfood.widget.apiKey"
    static let dateMode = "lzfood.widget.dateMode"
    static let customDateYmd = "lzfood.widget.customDateYmd"
    static let activeStoreIndex = "lzfood.widget.activeStoreIndex"
    static let defaultBaseURL = WidgetLocalDefaults.baseURL
}

private struct WidgetSharedConfig: Codable {
    var baseURL: String?
    var apiKey: String?
    var storeProfiles: [WidgetStoreProfile]?
    var activeStoreIndex: Int?
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

    private static var extensionDefaults: UserDefaults {
        defaults ?? .standard
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

    private static func normalizedProfiles(from cfg: WidgetSharedConfig) -> [WidgetStoreProfile] {
        if let profiles = cfg.storeProfiles?.filter({ !$0.trimmedApiKey.isEmpty }), !profiles.isEmpty {
            return Array(profiles.prefix(WidgetStoreProfiles.maxCount))
        }
        let legacy = cfg.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !legacy.isEmpty {
            return [WidgetStoreProfile(label: "店铺 1", apiKey: legacy)]
        }
        let udKey = defaults?.string(forKey: WidgetSettingsKeys.apiKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !udKey.isEmpty {
            return [WidgetStoreProfile(label: "店铺 1", apiKey: udKey)]
        }
        let local = WidgetLocalDefaults.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !local.isEmpty {
            return [WidgetStoreProfile(label: "店铺 1", apiKey: local)]
        }
        return []
    }

    static var storeProfiles: [WidgetStoreProfile] {
        normalizedProfiles(from: loadFileConfig())
    }

    /** 向后兼容：当前选中店铺的 Key */
    static var apiKey: String {
        activeProfile()?.trimmedApiKey ?? ""
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

    static var isConfigured: Bool {
        storeProfiles.contains(where: \.isValidKey)
    }

    static var canCycleStores: Bool {
        storeProfiles.filter(\.isValidKey).count > 1
    }

    static func activeStoreIndex(fallbackFromIntent intentIndex: Int = 0) -> Int {
        let profiles = storeProfiles.filter(\.isValidKey)
        guard !profiles.isEmpty else { return 0 }

        let stored: Int?
        if appGroupAvailable {
            stored = loadFileConfig().activeStoreIndex ?? defaults?.integer(forKey: WidgetSettingsKeys.activeStoreIndex)
        } else {
            stored = extensionDefaults.object(forKey: WidgetSettingsKeys.activeStoreIndex) != nil
                ? extensionDefaults.integer(forKey: WidgetSettingsKeys.activeStoreIndex)
                : intentIndex
        }

        let idx = stored ?? 0
        return ((idx % profiles.count) + profiles.count) % profiles.count
    }

    static func activeProfile(fallbackFromIntent intentIndex: Int = 0) -> WidgetStoreProfile? {
        let profiles = storeProfiles.filter(\.isValidKey)
        guard !profiles.isEmpty else { return nil }
        let idx = activeStoreIndex(fallbackFromIntent: intentIndex)
        return profiles[idx]
    }

    static func setActiveStoreIndex(_ index: Int) {
        let profiles = storeProfiles.filter(\.isValidKey)
        guard !profiles.isEmpty else { return }
        let clamped = ((index % profiles.count) + profiles.count) % profiles.count

        extensionDefaults.set(clamped, forKey: WidgetSettingsKeys.activeStoreIndex)
        defaults?.set(clamped, forKey: WidgetSettingsKeys.activeStoreIndex)

        var cfg = loadFileConfig()
        cfg.activeStoreIndex = clamped
        saveFileConfig(cfg)
    }

    static func cycleActiveStore(delta: Int, fallbackFromIntent intentIndex: Int = 0) {
        let current = activeStoreIndex(fallbackFromIntent: intentIndex)
        setActiveStoreIndex(current + delta)
    }

    /** App 保存时：UserDefaults + App Group 文件双写，确保 Widget 扩展能读到 */
    static func persistAll(
        baseURL: String,
        storeProfiles: [WidgetStoreProfile],
        dateMode: WidgetDateMode,
        customDateYmd: String,
        activeStoreIndex: Int? = nil,
    ) {
        let trimmedBase = baseURL.trimmingSuffix("/")
        let profiles = Array(
            storeProfiles
                .map {
                    WidgetStoreProfile(
                        id: $0.id,
                        label: $0.trimmedLabel,
                        apiKey: $0.trimmedApiKey
                    )
                }
                .filter { !$0.trimmedApiKey.isEmpty }
                .prefix(WidgetStoreProfiles.maxCount)
        )

        defaults?.set(trimmedBase, forKey: WidgetSettingsKeys.baseURL)
        defaults?.set(dateMode.rawValue, forKey: WidgetSettingsKeys.dateMode)
        defaults?.set(customDateYmd, forKey: WidgetSettingsKeys.customDateYmd)

        let firstKey = profiles.first?.trimmedApiKey ?? ""
        defaults?.set(firstKey, forKey: WidgetSettingsKeys.apiKey)

        var cfg = WidgetSharedConfig(
            baseURL: trimmedBase,
            apiKey: firstKey.isEmpty ? nil : firstKey,
            storeProfiles: profiles.isEmpty ? nil : profiles,
            activeStoreIndex: activeStoreIndex,
            dateMode: dateMode.rawValue,
            customDateYmd: customDateYmd,
        )

        if let activeStoreIndex {
            let valid = profiles.filter(\.isValidKey)
            if !valid.isEmpty {
                let clamped = ((activeStoreIndex % valid.count) + valid.count) % valid.count
                cfg.activeStoreIndex = clamped
                defaults?.set(clamped, forKey: WidgetSettingsKeys.activeStoreIndex)
                extensionDefaults.set(clamped, forKey: WidgetSettingsKeys.activeStoreIndex)
            }
        }

        saveFileConfig(cfg)
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
