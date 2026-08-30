import AppIntents
import WidgetKit
import SwiftUI

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    let logoData: Data?
    let errorMessage: String?

    static func placeholder() -> SnapshotEntry {
        SnapshotEntry(
            date: .now,
            snapshot: nil,
            logoData: nil,
            errorMessage: nil
        )
    }
}

struct SnapshotProvider: AppIntentTimelineProvider {
    typealias Entry = SnapshotEntry
    typealias Intent = WidgetSnapshotIntent

    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(
            date: .now,
            snapshot: demoSnapshot,
            logoData: nil,
            errorMessage: nil
        )
    }

    func snapshot(for configuration: WidgetSnapshotIntent, in context: Context) async -> SnapshotEntry {
        if context.isPreview {
            return placeholder(in: context)
        }
        return await loadEntry(for: configuration)
    }

    func timeline(for configuration: WidgetSnapshotIntent, in context: Context) async -> Timeline<SnapshotEntry> {
        let entry = await loadEntry(for: configuration)
        let next = nextReloadDate(for: configuration)
        return Timeline(entries: [entry], policy: .after(next))
    }

    /** 每 5 分钟刷新；「当天」模式额外在 Dublin 0 点切换日期 */
    private func nextReloadDate(for configuration: WidgetSnapshotIntent) -> Date {
        let fiveMinutes = Calendar.current.date(byAdding: .minute, value: 5, to: .now)
            ?? .now.addingTimeInterval(300)
        guard WidgetReportDateResolver.usesTodayMode(intent: configuration),
              let midnight = WidgetReportDate.nextDublinMidnight() else {
            return fiveMinutes
        }
        return min(fiveMinutes, midnight)
    }

    private func loadEntry(for configuration: WidgetSnapshotIntent) async -> SnapshotEntry {
        guard WidgetSettingsStore.isConfigured else {
            return SnapshotEntry(date: .now, snapshot: nil, logoData: nil, errorMessage: "打开 App 配置 API Key")
        }
        let ymd = WidgetReportDateResolver.reportDateYmd(intent: configuration)
        do {
            let snap = try await SnapshotClient.fetch(reportDateYmd: ymd)
            let logoData = await StoreLogoLoader.fetchData(from: snap.store.logoUrl)
            return SnapshotEntry(date: .now, snapshot: snap, logoData: logoData, errorMessage: nil)
        } catch {
            return SnapshotEntry(date: .now, snapshot: nil, logoData: nil, errorMessage: error.localizedDescription)
        }
    }

    private var demoSnapshot: WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: .now,
            timezone: "Europe/Dublin",
            date: "2026-08-30",
            store: .init(slug: "demo", displayName: "Demo Restaurant"),
            revenue: .init(netTotal: 1234.56, orderCount: 42),
            payments: .init(
                cash: .init(amount: 100, orderCount: 8),
                card: .init(amount: 800, orderCount: 25),
                online: .init(amount: 334.56, orderCount: 9)
            ),
            segments: .disabled
        )
    }
}
