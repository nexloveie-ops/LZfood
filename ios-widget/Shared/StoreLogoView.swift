import Foundation
#if canImport(UIKit)
import UIKit
#endif
import SwiftUI

enum StoreLogoLoader {
    static func fetchData(from urlString: String?) async -> Data? {
        guard let urlString, !urlString.isEmpty, let url = URL(string: urlString) else { return nil }
        do {
            var req = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 15)
            req.httpMethod = "GET"
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200 ... 299).contains(http.statusCode), !data.isEmpty else {
                return nil
            }
            return data
        } catch {
            return nil
        }
    }
}

struct StoreLogoView: View {
    let data: Data?
    var size: CGFloat = 24
    var cornerRadius: CGFloat?

    private var radius: CGFloat { cornerRadius ?? size * 0.22 }

    var body: some View {
        Group {
            #if canImport(UIKit)
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "storefront.fill")
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.22)
                    .foregroundStyle(Color.white.opacity(0.55))
            }
            #else
            Image(systemName: "storefront.fill")
                .resizable()
                .scaledToFit()
                .padding(size * 0.22)
                .foregroundStyle(Color.white.opacity(0.55))
            #endif
        }
        .frame(width: size, height: size)
        .background(Color.white.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5)
        }
    }
}
