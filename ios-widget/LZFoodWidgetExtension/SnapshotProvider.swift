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

struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(
            date: .now,
            snapshot: demoSnapshot,
            logoData: nil,
            errorMessage: nil
        )
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task {
            let entry = await loadEntry()
            completion(entry)
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        Task {
            let entry = await loadEntry()
            let next = Calendar.current.date(byAdding: .minute, value: 5, to: .now) ?? .now.addingTimeInterval(300)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private func loadEntry() async -> SnapshotEntry {
        guard WidgetSettingsStore.isConfigured else {
            return SnapshotEntry(date: .now, snapshot: nil, logoData: nil, errorMessage: "打开 App 配置 API Key")
        }
        do {
            let snap = try await SnapshotClient.fetch()
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
