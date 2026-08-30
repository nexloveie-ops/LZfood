import SwiftUI
import WidgetKit

struct ContentView: View {
    @State private var baseURL = WidgetSettingsStore.baseURL
    @State private var apiKey = WidgetSettingsStore.apiKey
    @State private var dateMode = WidgetSettingsStore.dateMode
    @State private var customDate = WidgetSettingsStore.customDate
    @State private var statusMessage = ""
    @State private var statusIsError = false
    @State private var isTesting = false
    @State private var preview: WidgetSnapshot?
    @State private var logoData: Data?

    private var pendingReportDateYmd: String {
        dateMode == .custom
            ? WidgetReportDate.ymdString(from: customDate)
            : WidgetReportDate.dublinTodayYmd()
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
                    .padding(.bottom, 16)

                if !statusMessage.isEmpty {
                    statusBanner
                        .padding(.horizontal, 20)
                        .padding(.bottom, 12)
                }

                connectionCard
                dateCard
                actionButtons
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)

                if let preview {
                    previewCard(preview)
                }

                helpCard
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
                    .padding(.bottom, 24)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .scrollContentBackground(.hidden)
        .contentMargins(.zero, for: .scrollContent)
        .contentMargins(.zero, for: .scrollIndicators)
        .safeAreaPadding(.horizontal, 0)
        .background {
            AppTheme.background
                .ignoresSafeArea()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(AppTheme.bgTop.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onAppear {
            baseURL = WidgetSettingsStore.baseURL
            apiKey = WidgetSettingsStore.apiKey
            dateMode = WidgetSettingsStore.dateMode
            customDate = WidgetSettingsStore.customDate
            persistAndReloadWidget()
            if !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Task { await refreshPreviewSilently() }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            StoreLogoView(data: logoData, size: 44, cornerRadius: 11)

            VStack(alignment: .leading, spacing: 2) {
                Text(preview?.store.displayName ?? "LZFood")
                    .font(.title3.bold())
                    .foregroundStyle(AppTheme.primary)
                    .lineLimit(1)
                Text("店主营业快照")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.muted)
            }
        }
    }

    private var statusBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: statusIsError ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                .foregroundStyle(statusIsError ? AppTheme.error : AppTheme.success)
            Text(statusMessage)
                .font(.subheadline)
                .foregroundStyle(AppTheme.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            (statusIsError ? AppTheme.error : AppTheme.success).opacity(0.12),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder((statusIsError ? AppTheme.error : AppTheme.success).opacity(0.35), lineWidth: 1)
        }
    }

    private var connectionCard: some View {
        CardSection(
            "连接",
            subtitle: "在 LZFOOD 管理端 → 餐馆信息 生成 Key。本地默认 http://127.0.0.1:8080",
            fullBleed: true
        ) {
            VStack(spacing: 14) {
                ThemedField(title: "API Base URL", placeholder: "https://food.lztechserve.com", text: $baseURL)
                ThemedField(title: "API Key", placeholder: "lzf_live_…", text: $apiKey, isSecure: true)
            }
        }
    }

    private var dateCard: some View {
        CardSection(
            "统计日期",
            subtitle: "选「当天」每次刷新用今日；选「自定义」固定该日。修改后自动保存并刷新 Widget。",
            fullBleed: true
        ) {
            VStack(alignment: .leading, spacing: 14) {
                Picker("统计日期", selection: $dateMode) {
                    ForEach(WidgetDateMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: dateMode) { _, newMode in
                    if newMode == .custom, WidgetSettingsStore.customDateYmd.isEmpty {
                        customDate = WidgetReportDate.date(fromYmd: WidgetReportDate.dublinYesterdayYmd()) ?? Date()
                    }
                    persistAndReloadWidget()
                    Task { await refreshPreviewSilently() }
                }

                if dateMode == .custom {
                    DatePicker("选择日期", selection: $customDate, displayedComponents: .date)
                        .datePickerStyle(.compact)
                        .tint(AppTheme.accent)
                        .foregroundStyle(AppTheme.primary)
                        .onChange(of: customDate) { _, _ in
                            persistAndReloadWidget()
                            Task { await refreshPreviewSilently() }
                        }
                }

                HStack(spacing: 6) {
                    Image(systemName: "calendar")
                        .font(.caption)
                    Text("Widget 将请求 \(pendingReportDateYmd)（Europe/Dublin）")
                        .font(.caption)
                }
                .foregroundStyle(AppTheme.dim)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(AppTheme.field, in: Capsule())

                if !WidgetSettingsStore.appGroupAvailable {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(AppTheme.error)
                        Group {
                            #if targetEnvironment(simulator)
                            Text("App Group 未生效：Widget 读不到你在 App 里改的日期/API。请运行 ./ios-widget/run.sh 重新安装。")
                            #else
                            Text("真机 App Group 未共享：配置 App 里的日期不会同步到 Widget。请在主屏幕长按 Widget → 编辑 → 改「统计日期」。")
                            #endif
                        }
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    private var actionButtons: some View {
        VStack(spacing: 10) {
            PrimaryButton(
                title: "保存并刷新 Widget",
                disabled: apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ) {
                persistAndReloadWidget()
                if WidgetSettingsStore.appGroupAvailable {
                    statusMessage = "已保存，Widget 正在刷新（\(WidgetSettingsStore.reportDateYmd)）"
                } else {
                    statusMessage = "已保存。真机请在主屏幕长按 Widget → 编辑 修改统计日期"
                }
                statusIsError = false
            }

            SecondaryButton(
                title: isTesting ? "测试中…" : "测试连接",
                disabled: isTesting || apiKey.isEmpty
            ) {
                Task { await testFetch() }
            }
        }
    }

    private func previewCard(_ snap: WidgetSnapshot) -> some View {
        CardSection("数据预览", subtitle: "与 Widget 同源快照", fullBleed: true) {
            VStack(alignment: .leading, spacing: 12) {
                widgetMiniPreview(snap)

                Divider().overlay(AppTheme.cardBorder)

                VStack(spacing: 8) {
                    previewRow("统计日", snap.date)
                    previewRow("现金", "\(snap.payments.cash.orderCount)单 · \(WidgetFormatters.euroString(snap.payments.cash.amount))")
                    previewRow("刷卡", "\(snap.payments.card.orderCount)单 · \(WidgetFormatters.euroString(snap.payments.card.amount))")
                    previewRow("Online", "\(snap.payments.online.orderCount)单 · \(WidgetFormatters.euroString(snap.payments.online.amount))")
                }
            }
        }
    }

    private func widgetMiniPreview(_ snap: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                StoreLogoView(data: logoData, size: 28, cornerRadius: 8)
                Text(snap.store.displayName)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(1)
                Spacer(minLength: 4)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(WidgetFormatters.euroString(snap.revenue.netTotal))
                        .font(.title3.bold())
                        .foregroundStyle(AppTheme.primary)
                    Text("\(snap.revenue.orderCount)单")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppTheme.dim)
                }
            }

            HStack(spacing: 12) {
                miniStat("现金", snap.payments.cash)
                miniStat("刷卡", snap.payments.card)
                miniStat("Online", snap.payments.online)
            }
        }
        .padding(14)
        .background(
            LinearGradient(
                colors: [Color(red: 0.08, green: 0.1, blue: 0.16), Color(red: 0.12, green: 0.14, blue: 0.22)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }

    private func miniStat(_ label: String, _ line: WidgetSnapshot.PaymentLine) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(AppTheme.dim)
            Text(WidgetFormatters.euroString(line.amount))
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(AppTheme.primary)
            Text("\(line.orderCount)单")
                .font(.caption2)
                .foregroundStyle(AppTheme.dim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func previewRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(AppTheme.muted)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.medium).monospacedDigit())
                .foregroundStyle(AppTheme.primary)
                .multilineTextAlignment(.trailing)
        }
    }

    private var helpCard: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "square.grid.2x2")
                .foregroundStyle(AppTheme.accent)
                .font(.body)
            Group {
                #if targetEnvironment(simulator)
                Text("保存后回到主屏幕 → 长按 → 添加小组件 → LZFood Widget。")
                #else
                Text("真机：保存 API Key 后添加 Widget。改统计日期请长按 Widget → 编辑（配置 App 与 Widget 未共享时）。")
                #endif
            }
            .font(.footnote)
            .foregroundStyle(AppTheme.dim)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 12)
    }

    private func persistAndReloadWidget() {
        let ymd = dateMode == .custom
            ? WidgetReportDate.ymdString(from: customDate)
            : WidgetReportDate.dublinTodayYmd()
        WidgetSettingsStore.persistAll(
            baseURL: baseURL,
            apiKey: apiKey,
            dateMode: dateMode,
            customDateYmd: ymd,
        )
        if dateMode == .custom {
            customDate = WidgetReportDate.date(fromYmd: ymd) ?? customDate
        }
        WidgetCenter.shared.reloadTimelines(ofKind: "LZFoodWidget")
    }

    private func fetchSnapshot() async throws -> WidgetSnapshot {
        try await SnapshotClient.fetch(
            baseURL: baseURL,
            apiKey: apiKey,
            reportDateYmd: pendingReportDateYmd,
        )
    }

    private func refreshPreviewSilently() async {
        do {
            let snap = try await fetchSnapshot()
            preview = snap
            logoData = await StoreLogoLoader.fetchData(from: snap.store.logoUrl)
        } catch {
            // Keep existing preview/logo on silent refresh failure.
        }
    }

    private func testFetch() async {
        isTesting = true
        defer { isTesting = false }
        persistAndReloadWidget()
        do {
            let snap = try await fetchSnapshot()
            preview = snap
            logoData = await StoreLogoLoader.fetchData(from: snap.store.logoUrl)
            statusMessage = "连接成功 · \(snap.date) · \(WidgetFormatters.euroString(snap.revenue.netTotal)) / \(snap.revenue.orderCount) 单"
            statusIsError = false
        } catch {
            preview = nil
            logoData = nil
            statusMessage = error.localizedDescription
            statusIsError = true
        }
    }
}

#Preview {
    ContentView()
}
