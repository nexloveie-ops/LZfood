import SwiftUI
import UIKit

@main
struct LZFoodWidgetApp: App {
    init() {
        UITableView.appearance().backgroundColor = .clear
        UICollectionView.appearance().backgroundColor = .clear
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
