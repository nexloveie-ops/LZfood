import SwiftUI
import WidgetKit

private enum WidgetColors {
    static let primary = Color.white
    static let muted = Color.white.opacity(0.82)
    static let dim = Color.white.opacity(0.68)
}

struct LZFoodWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        Group {
            if let msg = entry.errorMessage {
                ErrorWidgetView(message: msg)
            } else if let snap = entry.snapshot {
                switch family {
                case .systemMedium:
                    MediumWidgetView(snapshot: snap, logoData: entry.logoData)
                default:
                    SmallWidgetView(snapshot: snap, logoData: entry.logoData)
                }
            } else {
                ErrorWidgetView(message: "打开 App 配置 API Key")
            }
        }
        .containerBackground(for: .widget) {
            LinearGradient(
                colors: [Color(red: 0.08, green: 0.1, blue: 0.16), Color(red: 0.12, green: 0.14, blue: 0.22)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }
}

struct StoreHeaderRow: View {
    let displayName: String
    let netTotal: Double
    let orderCount: Int
    var logoData: Data? = nil
    var logoSize: CGFloat = 22
    var nameFont: Font = .headline.weight(.semibold)
    var amountFont: Font = .title.bold()
    var orderFont: Font = .subheadline.weight(.medium)

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            StoreLogoView(data: logoData, size: logoSize)

            Text(displayName)
                .font(nameFont)
                .foregroundStyle(WidgetColors.muted)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(0)

            Spacer(minLength: 4)

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(WidgetFormatters.euroString(netTotal))
                    .font(amountFont)
                    .foregroundStyle(WidgetColors.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                    .layoutPriority(1)

                Text("\(orderCount)单")
                    .font(orderFont)
                    .foregroundStyle(WidgetColors.muted)
                    .fixedSize()
            }
        }
        .frame(maxWidth: .infinity)
    }
}

struct SmallWidgetView: View {
    let snapshot: WidgetSnapshot
    var logoData: Data? = nil

    var body: some View {
        StoreHeaderRow(
            displayName: snapshot.store.displayName,
            netTotal: snapshot.revenue.netTotal,
            orderCount: snapshot.revenue.orderCount,
            logoData: logoData,
            logoSize: 20,
            nameFont: .subheadline.weight(.semibold),
            amountFont: .title2.bold(),
            orderFont: .caption.weight(.medium)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct MediumWidgetView: View {
    let snapshot: WidgetSnapshot
    var logoData: Data? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            StoreHeaderRow(
                displayName: snapshot.store.displayName,
                netTotal: snapshot.revenue.netTotal,
                orderCount: snapshot.revenue.orderCount,
                logoData: logoData,
                logoSize: 24
            )

            HStack(alignment: .bottom, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    PaymentRow(label: "现金", line: snapshot.payments.cash)
                    PaymentRow(label: "刷卡", line: snapshot.payments.card)
                    PaymentRow(label: "Online", line: snapshot.payments.online)
                }

                if case let .enabled(_, groups) = snapshot.segments, !groups.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("品类")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(WidgetColors.muted)
                        ForEach(groups.prefix(4)) { g in
                            SegmentGroupRow(group: g)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct SegmentGroupRow: View {
    let group: WidgetSnapshot.SegmentGroup

    var body: some View {
        HStack(spacing: 0) {
            Text(group.nameZh.isEmpty ? group.nameEn : group.nameZh)
                .font(.caption.weight(.medium))
                .foregroundStyle(WidgetColors.primary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text("\(group.orderCount)单")
                .font(.caption2.monospacedDigit().weight(.medium))
                .foregroundStyle(WidgetColors.muted)
                .frame(width: 38, alignment: .center)

            Text(String(format: "%.0f%%", group.sharePct))
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(WidgetColors.primary)
                .frame(width: 34, alignment: .trailing)
        }
    }
}

struct PaymentRow: View {
    let label: String
    let line: WidgetSnapshot.PaymentLine

    var body: some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(WidgetColors.muted)
            Text("\(line.orderCount)单")
                .font(.caption2.monospacedDigit().weight(.medium))
                .foregroundStyle(WidgetColors.dim)
            Spacer(minLength: 2)
            Text(WidgetFormatters.euroString(line.amount))
                .font(.caption.monospacedDigit().weight(.semibold))
                .foregroundStyle(WidgetColors.primary)
        }
    }
}

struct ErrorWidgetView: View {
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("LZFood")
                .font(.caption.bold())
                .foregroundStyle(WidgetColors.muted)
            Text(message)
                .font(.caption.weight(.medium))
                .foregroundStyle(WidgetColors.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}
