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
        .description("当天净营业额、订单数与支付方式。Medium 尺寸可点 ◀ ▶ 切换店铺（最多 4 家）。")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryRectangular,
            .accessoryCircular,
            .accessoryInline,
        ])
    }
}
