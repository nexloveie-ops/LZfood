import AppIntents
import WidgetKit
import SwiftUI

@main
struct LZFoodWidgetBundle: WidgetBundle {
    var body: some Widget {
        LZFoodWidget()
    }
}

struct LZFoodWidget: Widget {
    let kind = "LZFoodWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: WidgetSnapshotIntent.self, provider: SnapshotProvider()) { entry in
            LZFoodWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("LZFood 营业")
        .description("当天净营业额、订单数与支付方式。真机可在编辑 Widget 时改统计日期。")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryRectangular,
            .accessoryCircular,
            .accessoryInline,
        ])
    }
}
