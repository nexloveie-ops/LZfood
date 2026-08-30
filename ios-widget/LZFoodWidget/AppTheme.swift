import SwiftUI

enum AppTheme {
    static let bgTop = Color(red: 0.06, green: 0.08, blue: 0.13)
    static let bgBottom = Color(red: 0.1, green: 0.12, blue: 0.2)
    static let card = Color.white.opacity(0.07)
    static let cardBorder = Color.white.opacity(0.1)
    static let field = Color.white.opacity(0.06)
    static let primary = Color.white
    static let muted = Color.white.opacity(0.72)
    static let dim = Color.white.opacity(0.48)
    static let accent = Color(red: 0.45, green: 0.72, blue: 1.0)
    static let success = Color(red: 0.42, green: 0.84, blue: 0.58)
    static let error = Color(red: 1.0, green: 0.45, blue: 0.45)

    static var background: LinearGradient {
        LinearGradient(
            colors: [bgTop, bgBottom],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

struct CardSection<Content: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder var content: Content

    init(_ title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.primary)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(AppTheme.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
        }
    }
}

struct ThemedField: View {
    let title: String
    let placeholder: String
    @Binding var text: String
    var isSecure = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(AppTheme.muted)
            Group {
                if isSecure {
                    SecureField(placeholder, text: $text)
                } else {
                    TextField(placeholder, text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
            }
            .font(.subheadline)
            .foregroundStyle(AppTheme.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(AppTheme.field, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}

struct PrimaryButton: View {
    let title: String
    var isLoading = false
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .tint(.white)
                        .scaleEffect(0.85)
                }
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .foregroundStyle(.white)
            .background(
                LinearGradient(
                    colors: disabled
                        ? [Color.white.opacity(0.15), Color.white.opacity(0.1)]
                        : [AppTheme.accent, AppTheme.accent.opacity(0.75)],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
        }
        .disabled(disabled || isLoading)
    }
}

struct SecondaryButton: View {
    let title: String
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(AppTheme.primary)
                .background(AppTheme.field, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(AppTheme.cardBorder, lineWidth: 1)
                }
        }
        .disabled(disabled)
    }
}
