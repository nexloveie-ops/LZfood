import AppIntents
import Foundation

enum WidgetIntentDateMode: String, AppEnum {
    case today
    case custom

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "统计日期"

    static var caseDisplayRepresentations: [WidgetIntentDateMode: DisplayRepresentation] = [
        .today: "当天 (Dublin)",
        .custom: "自定义日期",
    ]
}

/// 真机无 App Group 时，用户在主屏幕「编辑 Widget」里改日期。
struct WidgetSnapshotIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "LZFood 营业"
    static var description = IntentDescription("选择 Widget 显示的营业统计日期（Europe/Dublin）。")

    @Parameter(title: "日期模式", default: .today)
    var dateMode: WidgetIntentDateMode

    @Parameter(title: "自定义 YYYY-MM-DD", default: "")
    var customDateYmd: String

    func reportDateYmd() -> String {
        switch dateMode {
        case .today:
            return WidgetReportDate.dublinTodayYmd()
        case .custom:
            let trimmed = customDateYmd.trimmingCharacters(in: .whitespacesAndNewlines)
            if WidgetReportDate.date(fromYmd: trimmed) != nil {
                return trimmed
            }
            return WidgetReportDate.dublinYesterdayYmd()
        }
    }
}

enum WidgetReportDateResolver {
    /** App Group 可用时以配置 App 为准；否则用 Widget 编辑页 Intent。 */
    static func reportDateYmd(intent: WidgetSnapshotIntent) -> String {
        if WidgetSettingsStore.appGroupAvailable {
            return WidgetSettingsStore.reportDateYmd
        }
        return intent.reportDateYmd()
    }

    static func usesTodayMode(intent: WidgetSnapshotIntent) -> Bool {
        if WidgetSettingsStore.appGroupAvailable {
            return WidgetSettingsStore.dateMode == .today
        }
        return intent.dateMode == .today
    }
}
