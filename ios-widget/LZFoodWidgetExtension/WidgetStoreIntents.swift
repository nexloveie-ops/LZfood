import AppIntents
import WidgetKit

enum StoreCycleDirection: String, AppEnum {
    case previous
    case next

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "方向"

    static var caseDisplayRepresentations: [StoreCycleDirection: DisplayRepresentation] = [
        .previous: "上一店",
        .next: "下一店",
    ]
}

struct CycleStoreIntent: AppIntent {
    static var title: LocalizedStringResource = "切换店铺"
    static var description = IntentDescription("在已配置的店铺之间轮换显示。")

    @Parameter(title: "方向")
    var direction: StoreCycleDirection

    init() {}

    init(direction: StoreCycleDirection) {
        self.direction = direction
    }

    func perform() async throws -> some IntentResult {
        let delta = direction == .next ? 1 : -1
        WidgetSettingsStore.cycleActiveStore(delta: delta)
        WidgetCenter.shared.reloadTimelines(ofKind: "LZFoodWidget")
        return .result()
    }
}
