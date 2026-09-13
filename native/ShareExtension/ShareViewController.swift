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
///
/// It does ask one question. Anyone with lists gets to pick which one the link
/// is for, since filing it later means finding it again on another device. With
/// no lists on the server there is nothing to pick, so the share stays the
/// wordless, zero-tap thing it was.
final class ShareViewController: UIViewController {

    /// Shape of `POST /api/links`. `created` is false when the link was already
    /// saved, which is worth telling the user apart from a fresh save.
    private struct SaveResponse: Decodable {
        let created: Bool
    }

    /// Body of the same call. `listId` is left out when nothing was picked,
    /// which is also what a build older than lists sent.
    private struct SaveRequest: Encodable {
        let url: String
        let listId: Int?
    }

    private struct ErrorResponse: Decodable {
        let error: String
    }

    /// One row of `GET /api/lists`. The web nav's link count comes down too and
    /// is ignored: a sheet this size is for choosing, not for browsing.
    private struct RemoteList: Decodable {
        let id: Int
        let name: String
        let icon: String?

        var label: String { icon.map { "\($0) \(name)" } ?? name }
    }

    private struct ListsResponse: Decodable {
        let lists: [RemoteList]
    }

    /// Where to post, and what to post with. Both are baked into Info.plist at
    /// build time from Config.xcconfig, so the extension needs no login session.
    private struct Server {
        let root: String
        let token: String

        static func fromBundle() throws -> Server {
            let info = Bundle.main.infoDictionary ?? [:]
            let root = (info["MarcadorServerURL"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            let token = (info["MarcadorToken"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""

            guard !root.isEmpty, !token.isEmpty else { throw ShareError.notConfigured }
            return Server(root: root, token: token)
        }

        // `host` is checked, not just parseability: the "//" in an xcconfig URL is
        // easy to get eaten as a comment, and the resulting "https:" parses
        // happily while pointing nowhere. Better to say so than to post into a void.
        func request(_ path: String, method: String) throws -> URLRequest {
            guard let endpoint = URL(string: root + path), endpoint.host?.isEmpty == false else {
                throw ShareError.notConfigured
            }

            var request = URLRequest(url: endpoint)
            request.httpMethod = method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            // Short by design: the server only reads or writes one row before
            // replying, so a slow response means something is wrong rather than
            // something is busy.
            request.timeoutInterval = 15

            return request
        }
    }

    /// The list picked last time, so sharing five things into "Recipes" is one
    /// tap each and not five trips through the menu. Extension-local on purpose:
    /// it is a convenience, and the server stays the record of what is filed where.
    private static let lastListKey = "MarcadorLastListID"

    private let card = UIView()
    private let content = UIStackView()
    private let statusRow = UIStackView()
    private let chooser = UIStackView()
    private let prompt = UILabel()
    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let listButton = UIButton(configuration: .gray(), primaryAction: nil)

    private var sharedLink: URL?
    private var lists: [RemoteList] = []
    private var chosenListID: Int?

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        buildInterface()

        Task { await begin() }
    }

    private func begin() async {
        do {
            let server = try Server.fromBundle()
            let url = try await sharedURL()
            sharedLink = url

            // One small request buys the choice. A failure here is swallowed
            // rather than reported: whatever went wrong — offline, a bad token,
            // a server that predates lists — the save below hits it too and
            // says so there, and a share with no list beats no share at all.
            let available = (try? await fetchLists(from: server)) ?? []

            if available.isEmpty {
                await save(url, to: server)
            } else {
                offer(available)
            }
        } catch {
            await report(error)
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

    private func fetchLists(from server: Server) async throws -> [RemoteList] {
        let (data, response) = try await URLSession.shared.data(for: server.request("/api/lists", method: "GET"))

        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ShareError.badResponse
        }

        return try JSONDecoder().decode(ListsResponse.self, from: data).lists
    }

    private func post(_ url: URL, listID: Int?, to server: Server) async throws -> Bool {
        var request = try server.request("/api/links", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(SaveRequest(url: url.absoluteString, listId: listID))

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ShareError.badResponse }

        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
            throw ShareError.server(status: http.statusCode, detail: detail)
        }

        return (try? JSONDecoder().decode(SaveResponse.self, from: data))?.created ?? true
    }

    /// Posts the link and reports the outcome, whichever way the sheet got here.
    private func save(_ url: URL, to server: Server) async {
        showProgress()

        do {
            let created = try await post(url, listID: chosenListID, to: server)
            remember(chosenListID)
            await finish(message: outcome(created: created))
        } catch {
            await report(error)
        }
    }

    /// "Saved to 📺 Tech" rather than "Saved": the sheet is gone before the list
    /// can be checked, so the confirmation is the only chance to catch a wrong tap.
    private func outcome(created: Bool) -> String {
        let verb = created ? "Saved" : "Already saved"
        guard let name = lists.first(where: { $0.id == chosenListID })?.label else { return verb }

        return "\(verb) to \(name)"
    }

    // MARK: - Choosing a list

    @MainActor
    private func offer(_ lists: [RemoteList]) {
        self.lists = lists
        chosenListID = remembered(among: lists)

        listButton.menu = menu(for: lists)
        statusRow.isHidden = true
        chooser.isHidden = false
    }

    private func menu(for lists: [RemoteList]) -> UIMenu {
        // Unfiled first and always present: most links belong nowhere in
        // particular, and that has to stay the cheapest answer.
        let unfiled = UIAction(title: "Unfiled", state: chosenListID == nil ? .on : .off) { [weak self] _ in
            self?.chosenListID = nil
        }

        let filed = lists.map { list in
            UIAction(title: list.label, state: chosenListID == list.id ? .on : .off) { [weak self] _ in
                self?.chosenListID = list.id
            }
        }

        // Single selection so the tick moves rather than accumulating, which is
        // also what lets the button title track the choice.
        return UIMenu(options: .singleSelection, children: [unfiled] + filed)
    }

    /// Deliberately checked against what the server just sent: a list deleted
    /// since the last share would otherwise be preselected and rejected on save.
    private func remembered(among lists: [RemoteList]) -> Int? {
        guard let id = UserDefaults.standard.object(forKey: Self.lastListKey) as? Int else { return nil }
        return lists.contains { $0.id == id } ? id : nil
    }

    private func remember(_ id: Int?) {
        let defaults = UserDefaults.standard

        if let id { defaults.set(id, forKey: Self.lastListKey) }
        else { defaults.removeObject(forKey: Self.lastListKey) }
    }

    @objc private func saveTapped() {
        guard let url = sharedLink else { return }

        Task {
            do {
                let server = try Server.fromBundle()
                await save(url, to: server)
            } catch {
                await report(error)
            }
        }
    }

    @objc private func cancelTapped() {
        // The host app is told the share did not happen, the same as dismissing
        // the sheet by hand.
        extensionContext?.cancelRequest(
            withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError),
        )
    }

    // MARK: - Outcome

    @MainActor
    private func showProgress() {
        chooser.isHidden = true
        statusRow.isHidden = false
        spinner.startAnimating()
        label.text = "Saving…"
    }

    @MainActor
    private func finish(message: String) async {
        spinner.stopAnimating()
        chooser.isHidden = true
        statusRow.isHidden = false
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

        // Covers the lists fetch as well as the save itself. Two strings would
        // mean a flicker on the common path, where the fetch takes a moment and
        // the sheet goes straight on to saving.
        label.text = "Saving…"
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label

        spinner.startAnimating()

        statusRow.axis = .horizontal
        statusRow.spacing = 10
        statusRow.alignment = .center
        statusRow.addArrangedSubview(spinner)
        statusRow.addArrangedSubview(label)

        content.axis = .vertical
        content.spacing = 16
        // Centred rather than filled, so the "Saving…" row keeps the compact
        // pill shape it has when there is no list to pick.
        content.alignment = .center
        content.translatesAutoresizingMaskIntoConstraints = false
        content.addArrangedSubview(statusRow)
        content.addArrangedSubview(buildChooser())
        card.addSubview(content)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: view.layoutMarginsGuide.leadingAnchor),
            card.trailingAnchor.constraint(lessThanOrEqualTo: view.layoutMarginsGuide.trailingAnchor),
            content.topAnchor.constraint(equalTo: card.topAnchor, constant: 18),
            content.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -18),
            content.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 22),
            content.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -22),
        ])
    }

    /// The list question: a menu button and the two ways out. Hidden until the
    /// server says there are lists to offer.
    private func buildChooser() -> UIStackView {
        prompt.text = "Save to"
        prompt.font = .preferredFont(forTextStyle: .headline)
        prompt.adjustsFontForContentSizeCategory = true
        prompt.textColor = .label

        // `changesSelectionAsPrimaryAction` makes the button read back the row
        // that is ticked, so the chosen list is visible without opening the menu.
        listButton.showsMenuAsPrimaryAction = true
        listButton.changesSelectionAsPrimaryAction = true
        listButton.setTitle("Unfiled", for: .normal)
        listButton.accessibilityLabel = "List to save this link to"

        let cancel = UIButton(configuration: .plain(), primaryAction: nil)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        let save = UIButton(configuration: .filled(), primaryAction: nil)
        save.setTitle("Save", for: .normal)
        save.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)

        let buttons = UIStackView(arrangedSubviews: [cancel, save])
        buttons.axis = .horizontal
        buttons.spacing = 8
        buttons.distribution = .fillEqually

        chooser.axis = .vertical
        chooser.spacing = 12
        chooser.alignment = .fill
        chooser.isHidden = true
        chooser.addArrangedSubview(prompt)
        chooser.addArrangedSubview(listButton)
        chooser.addArrangedSubview(buttons)

        // Wide enough that a menu button and two side-by-side actions do not
        // squeeze into a column; the card grows past it for a long list name.
        chooser.widthAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true

        return chooser
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
