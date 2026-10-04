import UIKit
import UniformTypeIdentifiers

/// The "marcador" row in the iOS and macOS share sheets.
///
/// The extension posts straight to the server rather than opening the app, so a
/// share works whether or not marcador is running, and the sheet dismisses in
/// well under a second. That is possible because the server stores the bare URL
/// and does the slow part — fetching the page, asking Mistral for a sentence —
/// on its own afterwards.
///
/// Deliberately not an `SLComposeServiceViewController`: that class dismisses
/// the moment Post is tapped, which leaves nowhere to report a failure. There is
/// nothing to compose here anyway, so this is a plain view controller that shows
/// its own progress and stays on screen long enough to say what happened.
final class ShareViewController: UIViewController {

    /// Shape of `POST /api/links`. `created` is false when the link was already
    /// saved, which is worth telling the user apart from a fresh save.
    private struct SaveResponse: Decodable {
        let created: Bool
    }

    private struct ErrorResponse: Decodable {
        let error: String
    }

    private let card = UIView()
    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        buildInterface()

        Task {
            do {
                let url = try await sharedURL()
                let created = try await save(url)
                await finish(message: created ? "Saved" : "Already saved")
            } catch {
                await report(error)
            }
        }
    }

    // MARK: - Extracting the shared link

    /// Safari hands over a `public.url`; some apps share the link as plain text
    /// instead, so fall back to scanning the text for something URL-shaped
    /// rather than refusing an otherwise perfectly good share.
    private func sharedURL() async throws -> URL {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }

        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = (try? await loadItem(from: provider, type: UTType.url.identifier)).flatMap(coerceToURL) {
                return url
            }
        }

        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = (try? await loadItem(from: provider, type: UTType.plainText.identifier)).flatMap(coerceToText),
               let url = firstURL(in: text) {
                return url
            }
        }

        throw ShareError.noURL
    }

    /// Bridges `loadItem`'s completion handler into async/await.
    private func loadItem(from provider: NSItemProvider, type: String) async throws -> NSSecureCoding? {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: item) }
            }
        }
    }

    /// `loadItem` promises no particular class for what it hands back: the same
    /// attachment can arrive as `NSURL`, `NSString` or `NSData` depending on the
    /// host app and the platform. Firefox on the Mac delivers the page URL as
    /// raw UTF-8 data, so anything stricter than "take every shape" reports a
    /// perfectly good share as containing no link at all.
    private func coerceToURL(_ item: NSSecureCoding?) -> URL? {
        switch item {
        case let url as URL:
            return url
        case let string as String:
            return URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines))
        case let data as Data:
            return String(data: data, encoding: .utf8)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .flatMap(URL.init(string:))
        default:
            return nil
        }
    }

    private func coerceToText(_ item: NSSecureCoding?) -> String? {
        switch item {
        case let string as String:
            return string
        case let data as Data:
            return String(data: data, encoding: .utf8)
        default:
            return nil
        }
    }

    private func firstURL(in text: String) -> URL? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return detector?.firstMatch(in: text, range: range)?.url
    }

    // MARK: - Talking to the server

    private func save(_ url: URL) async throws -> Bool {
        let info = Bundle.main.infoDictionary ?? [:]
        let server = (info["MarcadorServerURL"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let token = (info["MarcadorToken"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""

        // `host` is checked, not just parseability: the "//" in an xcconfig URL is
        // easy to get eaten as a comment, and the resulting "https:" parses
        // happily while pointing nowhere. Better to say so than to post into a void.
        guard !server.isEmpty, !token.isEmpty,
              let endpoint = URL(string: "\(server)/api/links"),
              endpoint.host?.isEmpty == false
        else {
            throw ShareError.notConfigured
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(["url": url.absoluteString])
        // Short by design: the server only writes a row before replying, so a
        // slow response means something is wrong rather than something is busy.
        request.timeoutInterval = 15

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShareError.badResponse }

        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
            throw ShareError.server(status: http.statusCode, detail: detail)
        }

        return (try? JSONDecoder().decode(SaveResponse.self, from: data))?.created ?? true
    }

    // MARK: - Outcome

    @MainActor
    private func finish(message: String) async {
        spinner.stopAnimating()
        label.text = message
        // Long enough to read, short enough not to feel like a wait.
        try? await Task.sleep(for: .milliseconds(650))
        extensionContext?.completeRequest(returningItems: nil)
    }

    @MainActor
    private func report(_ error: Error) async {
        spinner.stopAnimating()
        card.isHidden = true

        let alert = UIAlertController(
            title: "Couldn’t save",
            message: (error as? ShareError)?.message ?? error.localizedDescription,
            preferredStyle: .alert,
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            // Cancel, not complete: the share did not happen, and the host app
            // should be told so.
            self?.extensionContext?.cancelRequest(withError: error)
        })
        present(alert, animated: true)
    }

    // MARK: - Interface

    private func buildInterface() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)

        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 14
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        label.text = "Saving…"
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label

        spinner.startAnimating()

        let row = UIStackView(arrangedSubviews: [spinner, label])
        row.spacing = 10
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(row)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            row.topAnchor.constraint(equalTo: card.topAnchor, constant: 18),
            row.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -18),
            row.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 22),
            row.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -22),
        ])
    }
}

private enum ShareError: Error {
    case noURL
    case notConfigured
    case badResponse
    case server(status: Int, detail: String?)

    var message: String {
        switch self {
        case .noURL:
            return "Nothing shared here looks like a link."
        case .notConfigured:
            return "This build has no usable server address or token. Check native/ShareExtension/Config.xcconfig — note the URL needs the \"https:/$()/host\" escape — then rebuild."
        case .badResponse:
            return "The server sent something unexpected."
        case .server(let status, let detail):
            if status == 401 { return "The token in this build was rejected. Check MARCADOR_TOKEN." }
            return detail ?? "The server returned HTTP \(status)."
        }
    }
}
