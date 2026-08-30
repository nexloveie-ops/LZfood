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
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            LZFoodWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("LZFood 营业")
        .description("当天净营业额、订单数与支付方式。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
