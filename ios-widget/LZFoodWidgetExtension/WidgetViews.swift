import SwiftUI
import WidgetKit

private enum WidgetColors {
    static let primary = Color.white
    static let muted = Color.white.opacity(0.82)
    static let dim = Color.white.opacity(0.68)
}

private enum WidgetBackground {
    static var gradient: LinearGradient {
        LinearGradient(
            colors: [Color(red: 0.08, green: 0.1, blue: 0.16), Color(red: 0.12, green: 0.14, blue: 0.22)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

struct LZFoodWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SnapshotEntry

    var body: some View {
        Group {
            if let msg = entry.errorMessage {
                ErrorWidgetView(message: msg, family: family)
            } else if let snap = entry.snapshot {
                switch family {
                case .systemMedium:
                    MediumWidgetView(snapshot: snap, logoData: entry.logoData)
                case .accessoryRectangular:
                    LockRectangularWidgetView(snapshot: snap, logoData: entry.logoData)
                case .accessoryCircular:
                    LockCircularWidgetView(snapshot: snap, logoData: entry.logoData)
                case .accessoryInline:
                    LockInlineWidgetView(snapshot: snap)
                default:
                    SmallWidgetView(snapshot: snap, logoData: entry.logoData)
                }
            } else {
                ErrorWidgetView(message: "打开 App 配置 API Key", family: family)
            }
        }
        .containerBackground(for: .widget) {
            WidgetBackground.gradient
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
    var compact = false

    private var headerLogoSize: CGFloat { compact ? 16 : 24 }
    private var headerNameFont: Font { compact ? .caption2.weight(.semibold) : .headline.weight(.semibold) }
    private var headerAmountFont: Font { compact ? .caption.weight(.bold) : .title.bold() }
    private var headerOrderFont: Font { compact ? .caption2.weight(.medium) : .subheadline.weight(.medium) }
    private var sectionSpacing: CGFloat { compact ? 3 : 6 }
    private var columnSpacing: CGFloat { compact ? 8 : 12 }
    private var maxSegments: Int { compact ? 2 : 4 }

    var body: some View {
        VStack(alignment: .leading, spacing: sectionSpacing) {
            StoreHeaderRow(
                displayName: snapshot.store.displayName,
                netTotal: snapshot.revenue.netTotal,
                orderCount: snapshot.revenue.orderCount,
                logoData: logoData,
                logoSize: headerLogoSize,
                nameFont: headerNameFont,
                amountFont: headerAmountFont,
                orderFont: headerOrderFont
            )

            HStack(alignment: .bottom, spacing: columnSpacing) {
                VStack(alignment: .leading, spacing: compact ? 2 : 6) {
                    PaymentRow(label: "现金", line: snapshot.payments.cash, compact: compact)
                    PaymentRow(label: "刷卡", line: snapshot.payments.card, compact: compact)
                    PaymentRow(label: "Online", line: snapshot.payments.online, compact: compact)
                }

                if case let .enabled(_, groups) = snapshot.segments, !groups.isEmpty {
                    VStack(alignment: .leading, spacing: compact ? 2 : 4) {
                        Text("品类")
                            .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                            .foregroundStyle(WidgetColors.muted)
                        ForEach(groups.prefix(maxSegments)) { g in
                            SegmentGroupRow(group: g, compact: compact)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct LockRectangularWidgetView: View {
    let snapshot: WidgetSnapshot
    var logoData: Data? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            StoreHeaderRow(
                displayName: snapshot.store.displayName,
                netTotal: snapshot.revenue.netTotal,
                orderCount: snapshot.revenue.orderCount,
                logoData: logoData,
                logoSize: 15,
                nameFont: .caption2.weight(.semibold),
                amountFont: .caption.weight(.bold),
                orderFont: .caption2.weight(.medium)
            )

            HStack(spacing: 4) {
                LockPaymentColumn(label: "现金", line: snapshot.payments.cash)
                LockPaymentColumn(label: "刷卡", line: snapshot.payments.card)
                LockPaymentColumn(label: "Online", line: snapshot.payments.online)
            }
            .frame(maxWidth: .infinity)

            if case let .enabled(_, groups) = snapshot.segments, !groups.isEmpty {
                HStack(spacing: 4) {
                    ForEach(groups.prefix(3)) { g in
                        LockSegmentChip(group: g)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

struct LockPaymentColumn: View {
    let label: String
    let line: WidgetSnapshot.PaymentLine

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(WidgetColors.muted)
                .lineLimit(1)
            Text(WidgetFormatters.euroString(line.amount))
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(WidgetColors.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text("\(line.orderCount)单")
                .font(.caption2.weight(.medium))
                .foregroundStyle(WidgetColors.dim)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct LockSegmentChip: View {
    let group: WidgetSnapshot.SegmentGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(group.nameZh.isEmpty ? group.nameEn : group.nameZh)
                .font(.caption2.weight(.medium))
                .foregroundStyle(WidgetColors.primary)
                .lineLimit(1)
            Text("\(group.orderCount)单 · \(String(format: "%.0f%%", group.sharePct))")
                .font(.caption2.monospacedDigit().weight(.medium))
                .foregroundStyle(WidgetColors.dim)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct LockCircularWidgetView: View {
    let snapshot: WidgetSnapshot
    var logoData: Data? = nil

    var body: some View {
        VStack(spacing: 2) {
            StoreLogoView(data: logoData, size: 22, cornerRadius: 6)
            Text(WidgetFormatters.euroString(snapshot.revenue.netTotal))
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(WidgetColors.primary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text("\(snapshot.revenue.orderCount)单")
                .font(.caption2.weight(.medium))
                .foregroundStyle(WidgetColors.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct LockInlineWidgetView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        Text("\(snapshot.store.displayName) \(WidgetFormatters.euroString(snapshot.revenue.netTotal)) · \(snapshot.revenue.orderCount)单")
            .font(.caption.weight(.semibold))
            .foregroundStyle(WidgetColors.primary)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SegmentGroupRow: View {
    let group: WidgetSnapshot.SegmentGroup
    var compact = false

    var body: some View {
        HStack(spacing: 0) {
            Text(group.nameZh.isEmpty ? group.nameEn : group.nameZh)
                .font(compact ? .caption2.weight(.medium) : .caption.weight(.medium))
                .foregroundStyle(WidgetColors.primary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text("\(group.orderCount)单")
                .font(.caption2.monospacedDigit().weight(.medium))
                .foregroundStyle(WidgetColors.muted)
                .frame(width: compact ? 28 : 38, alignment: .center)

            Text(String(format: "%.0f%%", group.sharePct))
                .font(.caption2.monospacedDigit().weight(.semibold))
                .foregroundStyle(WidgetColors.primary)
                .frame(width: compact ? 26 : 34, alignment: .trailing)
        }
    }
}

struct PaymentRow: View {
    let label: String
    let line: WidgetSnapshot.PaymentLine
    var compact = false

    var body: some View {
        HStack(spacing: compact ? 2 : 4) {
            Text(label)
                .font(compact ? .caption2.weight(.medium) : .caption.weight(.medium))
                .foregroundStyle(WidgetColors.muted)
            Text("\(line.orderCount)单")
                .font(.caption2.monospacedDigit().weight(.medium))
                .foregroundStyle(WidgetColors.dim)
            Spacer(minLength: 2)
            Text(WidgetFormatters.euroString(line.amount))
                .font(compact ? .caption2.monospacedDigit().weight(.semibold) : .caption.monospacedDigit().weight(.semibold))
                .foregroundStyle(WidgetColors.primary)
        }
    }
}

struct ErrorWidgetView: View {
    let message: String
    var family: WidgetFamily = .systemSmall

    var body: some View {
        Group {
            switch family {
            case .accessoryInline:
                Text(message)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(WidgetColors.primary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .accessoryRectangular:
                Text(message)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(WidgetColors.primary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            case .accessoryCircular:
                VStack(spacing: 2) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(WidgetColors.muted)
                    Text(message)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(WidgetColors.primary)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            default:
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
    }
}
