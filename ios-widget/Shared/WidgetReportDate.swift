import Foundation

enum WidgetReportDate {
    static let dublinTimeZone = TimeZone(identifier: "Europe/Dublin")!

    private static var dublinCalendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = dublinTimeZone
        return cal
    }

    static func dublinTodayYmd(from date: Date = Date()) -> String {
        ymdString(from: date)
    }

    static func dublinYesterdayYmd(from date: Date = Date()) -> String {
        guard let yesterday = dublinCalendar.date(byAdding: .day, value: -1, to: date) else {
            return ymdString(from: date)
        }
        return ymdString(from: yesterday)
    }

    static func ymdString(from date: Date) -> String {
        let c = dublinCalendar.dateComponents([.year, .month, .day], from: date)
        guard let y = c.year, let m = c.month, let d = c.day else { return "1970-01-01" }
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    /** 将 YYYY-MM-DD 解析为 Dublin 当日中午，避免 DatePicker 时区偏移 */
    static func date(fromYmd ymd: String) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var comps = DateComponents()
        comps.calendar = dublinCalendar
        comps.timeZone = dublinTimeZone
        comps.year = parts[0]
        comps.month = parts[1]
        comps.day = parts[2]
        comps.hour = 12
        return dublinCalendar.date(from: comps)
    }

    /** 下一次 Europe/Dublin 日界（00:00） */
    static func nextDublinMidnight(after refDate: Date = Date()) -> Date? {
        let todayYmd = ymdString(from: refDate)
        guard let noon = date(fromYmd: todayYmd) else { return nil }
        guard var comps = dublinCalendar.dateComponents([.year, .month, .day], from: noon) as DateComponents? else {
            return nil
        }
        comps.day = (comps.day ?? 0) + 1
        comps.hour = 0
        comps.minute = 0
        comps.second = 0
        comps.timeZone = dublinTimeZone
        return dublinCalendar.date(from: comps)
    }
}

enum WidgetDateMode: String, CaseIterable, Identifiable, Codable {
    case today
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .today: return "当天"
        case .custom: return "自定义日期"
        }
    }
}
