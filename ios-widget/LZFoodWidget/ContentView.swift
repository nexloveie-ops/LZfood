import SwiftUI
import WidgetKit

struct ContentView: View {
    @State private var baseURL = WidgetSettingsStore.baseURL
    @State private var storeProfiles: [WidgetStoreProfile] = []
    @State private var previewStoreIndex = 0
    @State private var dateMode = WidgetSettingsStore.dateMode
    @State private var customDate = WidgetSettingsStore.customDate
    @State private var statusMessage = ""
    @State private var statusIsError = false
    @State private var isTesting = false
    @State private var preview: WidgetSnapshot?
    @State private var logoData: Data?
    @State private var isConnectionExpanded = false

    private var pendingReportDateYmd: String {
        dateMode == .custom
            ? WidgetReportDate.ymdString(from: customDate)
            : WidgetReportDate.dublinTodayYmd()
    }

    private var validProfiles: [WidgetStoreProfile] {
        storeProfiles.filter(\.isValidKey)
    }

    private var previewProfile: WidgetStoreProfile? {
        let valid = validProfiles
        guard !valid.isEmpty else { return storeProfiles.first }
        let idx = ((previewStoreIndex % valid.count) + valid.count) % valid.count
        return valid[idx]
    }

    private var connectionSummary: String {
        let valid = validProfiles
        if valid.isEmpty {
            return storeProfiles.first?.trimmedApiKey.isEmpty == false ? "已填写 Key" : "未配置 API Key"
        }
        if valid.count == 1 {
            return valid[0].displayLabel
        }
        return "已配置 \(valid.count) 家店"
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

                dateCard

                if let preview {
                    previewCard(preview)
                }

                helpCard
                    .padding(.horizontal, 20)
                    .padding(.top, 8)

                collapsibleConnectionSection
                    .padding(.top, 16)
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
            loadFromStore()
            persistAndReloadWidget()
            if validProfiles.isEmpty == false {
                Task { await refreshPreviewSilently() }
            }
        }
    }

    private func loadFromStore() {
        baseURL = WidgetSettingsStore.baseURL
        let loaded = WidgetSettingsStore.storeProfiles
        storeProfiles = loaded.isEmpty
            ? [WidgetStoreProfile(label: "店铺 1", apiKey: "")]
            : loaded
        previewStoreIndex = WidgetSettingsStore.activeStoreIndex()
        dateMode = WidgetSettingsStore.dateMode
        customDate = WidgetSettingsStore.customDate
    }

    private var header: some View {
        HStack(spacing: 14) {
            StoreLogoView(data: logoData, size: 44, cornerRadius: 11)

            VStack(alignment: .leading, spacing: 2) {
                Text(preview?.store.displayName ?? "LZFood")
                    .font(.title3.bold())
                    .foregroundStyle(AppTheme.primary)
                    .lineLimit(1)
                Text("店主营业快照 · 最多 \(WidgetStoreProfiles.maxCount) 店")
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
        VStack(spacing: 14) {
            ThemedField(title: "API Base URL", placeholder: "https://food.lztechserve.com", text: $baseURL)

            ForEach($storeProfiles) { $profile in
                storeProfileRow(profile: $profile)
            }

            if storeProfiles.count < WidgetStoreProfiles.maxCount {
                Button {
                    storeProfiles.append(WidgetStoreProfile(label: "店铺 \(storeProfiles.count + 1)", apiKey: ""))
                } label: {
                    Label("添加店铺", systemImage: "plus.circle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppTheme.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var collapsibleConnectionSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.22)) {
                    isConnectionExpanded.toggle()
                }
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("连接")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppTheme.primary)
                        Text(connectionSummary)
                            .font(.caption)
                            .foregroundStyle(AppTheme.dim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.muted)
                        .rotationEffect(.degrees(isConnectionExpanded ? 180 : 0))
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isConnectionExpanded {
                VStack(alignment: .leading, spacing: 0) {
                    Rectangle()
                        .fill(AppTheme.cardBorder)
                        .frame(height: 1)

                    VStack(alignment: .leading, spacing: 14) {
                        Text("每家店在 LZFOOD 管理端 → 餐馆信息 各生成一个 Key。Medium Widget 可点 ◀ ▶ 切换。")
                            .font(.caption)
                            .foregroundStyle(AppTheme.dim)
                            .fixedSize(horizontal: false, vertical: true)

                        connectionCard

                        actionButtons
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.card)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(AppTheme.cardBorder)
                .frame(height: 1)
        }
    }

    private func storeProfileRow(profile: Binding<WidgetStoreProfile>) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(profile.wrappedValue.displayLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppTheme.muted)
                Spacer()
                if storeProfiles.count > 1 {
                    Button(role: .destructive) {
                        storeProfiles.removeAll { $0.id == profile.wrappedValue.id }
                        if previewStoreIndex >= storeProfiles.count {
                            previewStoreIndex = max(0, storeProfiles.count - 1)
                        }
                    } label: {
                        Image(systemName: "trash")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                }
            }

            ThemedField(title: "店铺名称", placeholder: "例如 Taste of HK", text: profile.label)
            ThemedField(title: "API Key", placeholder: "lzf_live_…", text: profile.apiKey, isSecure: true)
        }
        .padding(12)
        .background(AppTheme.field.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
                            Text("App Group 未生效：Widget 读不到多店配置。请运行 ./ios-widget/run.sh 重新安装。")
                            #else
                            Text("真机 App Group 未共享：多店切换需在 Medium Widget 点 ◀ ▶；日期请在 Widget 编辑页修改。")
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
                disabled: !storeProfiles.contains(where: { !$0.trimmedApiKey.isEmpty })
            ) {
                persistAndReloadWidget()
                if WidgetSettingsStore.appGroupAvailable {
                    statusMessage = "已保存 \(validProfiles.count) 店，Widget 正在刷新（\(WidgetSettingsStore.reportDateYmd)）"
                } else {
                    statusMessage = "已保存。多店切换请用 Medium Widget 底部 ◀ ▶"
                }
                statusIsError = false
            }

            SecondaryButton(
                title: isTesting ? "测试中…" : "测试当前店铺连接",
                disabled: isTesting || previewProfile == nil
            ) {
                Task { await testFetch() }
            }
        }
    }

    private func previewCard(_ snap: WidgetSnapshot) -> some View {
        CardSection("数据预览", subtitle: "与 Widget 同源快照", fullBleed: true) {
            VStack(alignment: .leading, spacing: 12) {
                if validProfiles.count > 1 {
                    HStack {
                        Button {
                            cyclePreviewStore(delta: -1)
                        } label: {
                            Image(systemName: "chevron.left.circle.fill")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(AppTheme.accent)

                        Text("\(previewProfile?.displayLabel ?? "") · \(previewStoreIndex + 1)/\(validProfiles.count)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(AppTheme.muted)
                            .frame(maxWidth: .infinity)

                        Button {
                            cyclePreviewStore(delta: 1)
                        } label: {
                            Image(systemName: "chevron.right.circle.fill")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(AppTheme.accent)
                    }
                }

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

    private func cyclePreviewStore(delta: Int) {
        let valid = validProfiles
        guard valid.count > 1 else { return }
        previewStoreIndex = (previewStoreIndex + delta + valid.count) % valid.count
        WidgetSettingsStore.setActiveStoreIndex(previewStoreIndex)
        WidgetCenter.shared.reloadTimelines(ofKind: "LZFoodWidget")
        Task { await refreshPreviewSilently() }
    }

    private func widgetMiniPreview(_ snap: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                StoreLogoView(data: logoData, size: 28, cornerRadius: 8)

                Text(snap.store.displayName)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text(WidgetFormatters.euroString(snap.revenue.netTotal))
                    .font(.title3.bold())
                    .foregroundStyle(AppTheme.primary)
                    .fixedSize(horizontal: true, vertical: false)
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
                Text("保存后添加 Medium 尺寸 Widget；底部 ◀ ▶ 可在已保存的店铺间切换。")
                #else
                Text("保存多店 Key 后添加 Medium Widget；点 ◀ ▶ 切换店铺。Small 尺寸仅显示当前店序号。")
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
        let valid = storeProfiles.filter { !$0.trimmedApiKey.isEmpty }
        let idx = valid.isEmpty ? 0 : min(previewStoreIndex, valid.count - 1)
        previewStoreIndex = idx
        WidgetSettingsStore.persistAll(
            baseURL: baseURL,
            storeProfiles: storeProfiles,
            dateMode: dateMode,
            customDateYmd: ymd,
            activeStoreIndex: idx,
        )
        if dateMode == .custom {
            customDate = WidgetReportDate.date(fromYmd: ymd) ?? customDate
        }
        WidgetCenter.shared.reloadTimelines(ofKind: "LZFoodWidget")
    }

    private func fetchSnapshot(for profile: WidgetStoreProfile) async throws -> WidgetSnapshot {
        try await SnapshotClient.fetch(
            baseURL: baseURL,
            apiKey: profile.trimmedApiKey,
            reportDateYmd: pendingReportDateYmd,
        )
    }

    private func refreshPreviewSilently() async {
        guard let profile = previewProfile, profile.isValidKey else { return }
        do {
            let snap = try await fetchSnapshot(for: profile)
            preview = snap
            logoData = await StoreLogoLoader.fetchData(from: snap.store.logoUrl)
        } catch {
            // Keep existing preview/logo on silent refresh failure.
        }
    }

    private func testFetch() async {
        guard let profile = previewProfile else { return }
        isTesting = true
        defer { isTesting = false }
        persistAndReloadWidget()
        do {
            let snap = try await fetchSnapshot(for: profile)
            preview = snap
            logoData = await StoreLogoLoader.fetchData(from: snap.store.logoUrl)
            statusMessage = "连接成功 · \(profile.displayLabel) · \(snap.date) · \(WidgetFormatters.euroString(snap.revenue.netTotal)) / \(snap.revenue.orderCount) 单"
            statusIsError = false
        } catch {
            preview = nil
            logoData = nil
            statusMessage = "\(profile.displayLabel): \(error.localizedDescription)"
            statusIsError = true
        }
    }
}

#Preview {
    ContentView()
}
