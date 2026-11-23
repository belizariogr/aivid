// App do Mac: inicia o servidor local do Takes (Node) e mostra a interface numa janela WebKit.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var serverInput: Pipe?
    var port = 4477
    var quitting = false
    var ready = false

    let appDir = Bundle.main.resourceURL!.appendingPathComponent("app")
    let logURL: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Takes")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("servidor.log")
    }()

    // MARK: ciclo de vida

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        showMessage("Iniciando o Takes…", detail: "")
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard ready, let server, server.isRunning, !quitting else { return .terminateNow }
        activeJobs { count in
            if count > 0 {
                let alert = NSAlert()
                alert.messageText = count == 1 ? "Há uma geração em andamento." : "Há \(count) gerações em andamento ou na fila."
                alert.informativeText = "Sair do Takes cancela essas gerações no LTX Desktop. Os blocos já salvos continuam na pasta de saída."
                alert.addButton(withTitle: "Sair e cancelar")
                alert.addButton(withTitle: "Continuar gerando")
                if alert.runModal() != .alertFirstButtonReturn {
                    sender.reply(toApplicationShouldTerminate: false)
                    return
                }
            }
            self.stopServer { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        if let server, server.isRunning { server.terminate() }
    }

    // MARK: servidor

    func findNode() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.volta/bin/node", "/usr/bin/node"]
        if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return found }
        // Apps abertos pelo Finder não herdam o PATH do terminal: pergunta ao shell de login.
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
        shell.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        shell.standardOutput = out
        shell.standardError = FileHandle.nullDevice
        do { try shell.run() } catch { return nil }
        shell.waitUntilExit()
        let path = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return path.isEmpty ? nil : path
    }

    func portIsFree(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        return result == 0
    }

    func startServer() {
        guard let node = findNode() else {
            showMessage("Node.js não encontrado", detail: "Instale com <code>brew install node</code> e abra o Takes de novo.")
            return
        }
        port = (4477...4520).first(where: portIsFree) ?? 0
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        let log = try? FileHandle(forWritingTo: logURL)
        log?.truncateFile(atOffset: 0)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [appDir.appendingPathComponent("server/index.js").path, "--no-open"]
        process.currentDirectoryURL = appDir
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["TAKES_EXIT_WITH_PARENT"] = "1"
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        process.environment = env
        let input = Pipe()
        process.standardInput = input
        serverInput = input
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        // Lê a saída para descobrir a porta e grava tudo no registro.
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            log?.write(data)
            guard let text = String(data: data, encoding: .utf8),
                  let range = text.range(of: #"Takes rodando em http://127\.0\.0\.1:(\d+)"#, options: .regularExpression) else { return }
            let port = Int(text[range].split(separator: ":").last ?? "") ?? 0
            DispatchQueue.main.async { self?.serverReady(port: port) }
        }
        process.terminationHandler = { [weak self] p in
            DispatchQueue.main.async {
                guard let self, !self.quitting else { return }
                self.ready = false
                let tail = (try? String(contentsOf: self.logURL, encoding: .utf8))?.split(separator: "\n").suffix(12).joined(separator: "\n") ?? ""
                self.showMessage("O servidor do Takes parou (código \(p.terminationStatus)).", detail: "<pre>\(tail.htmlEscaped)</pre><p><a href=\"takes:restart\">Reiniciar</a></p>")
            }
        }
        do {
            try process.run()
            server = process
        } catch {
            showMessage("Não foi possível iniciar o servidor.", detail: error.localizedDescription.htmlEscaped)
        }
    }

    func serverReady(port: Int) {
        guard !ready else { return }
        ready = true
        self.port = port
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
    }

    func stopServer(_ done: @escaping () -> Void) {
        quitting = true
        guard let server, server.isRunning else { return done() }
        server.terminate() // o servidor cancela as gerações do LTX ao receber SIGTERM
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(6)
            while server.isRunning && Date() < deadline { usleep(50_000) }
            if server.isRunning { kill(server.processIdentifier, SIGKILL) }
            DispatchQueue.main.async(execute: done)
        }
    }

    func activeJobs(_ completion: @escaping (Int) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/jobs")!)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { data, _, _ in
            var count = 0
            if let data, let jobs = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                count = jobs.filter { ["queued", "running"].contains($0["status"] as? String ?? "") }.count
            }
            DispatchQueue.main.async { completion(count) }
        }.resume()
    }

    @objc func restartServer() {
        quitting = true
        let wasRunning = server?.isRunning ?? false
        let restart = {
            self.quitting = false
            self.ready = false
            self.showMessage("Reiniciando o Takes…", detail: "")
            self.startServer()
        }
        if wasRunning { stopServer(restart) } else { restart() }
    }

    @objc func showLog() { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
    @objc func showLibrary() {
        let lib = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Takes")
        try? FileManager.default.createDirectory(at: lib, withIntermediateDirectories: true)
        NSWorkspace.shared.open(lib)
    }
    @objc func reload() { if ready { webView.reload() } }
    @objc func openInBrowser() { if ready { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)/")!) } }

    // MARK: janela

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "takes")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.isInspectable = true
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 880), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Takes"
        window.minSize = NSSize(width: 900, height: 600)
        window.backgroundColor = NSColor(red: 0.07, green: 0.067, blue: 0.063, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("TakesMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func showMessage(_ title: String, detail: String) {
        let html = """
        <html><head><meta charset="utf-8"><style>
        body{background:#121110;color:#ece7df;font:15px -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0}
        div{max-width:640px;padding:24px} h1{font-size:20px} pre{white-space:pre-wrap;color:#9a938a;font-size:12px} a{color:#f2b14b}
        code{background:#23211e;padding:2px 6px;border-radius:4px}
        </style></head><body><div><h1>\(title.htmlEscaped)</h1>\(detail)</div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }
        let app = NSMenu()
        app.addItem(item("Sobre o Takes", #selector(NSApplication.orderFrontStandardAboutPanel(_:))))
        app.addItem(.separator())
        app.addItem(item("Abrir biblioteca de projetos", #selector(showLibrary), target: self))
        app.addItem(item("Mostrar registro do servidor", #selector(showLog), target: self))
        app.addItem(item("Reiniciar servidor", #selector(restartServer), target: self))
        app.addItem(.separator())
        app.addItem(item("Ocultar Takes", #selector(NSApplication.hide(_:)), "h"))
        app.addItem(item("Ocultar outros", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        app.addItem(.separator())
        app.addItem(item("Sair do Takes", #selector(NSApplication.terminate(_:)), "q"))
        let edit = NSMenu(title: "Editar")
        edit.addItem(item("Desfazer", Selector(("undo:")), "z"))
        edit.addItem(item("Refazer", Selector(("redo:")), "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(item("Recortar", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copiar", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Colar", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Selecionar tudo", #selector(NSText.selectAll(_:)), "a"))
        let view = NSMenu(title: "Visualizar")
        view.addItem(item("Recarregar", #selector(reload), "r", target: self))
        view.addItem(item("Abrir no navegador", #selector(openInBrowser), target: self))
        view.addItem(.separator())
        view.addItem(item("Tela cheia", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        let win = NSMenu(title: "Janela")
        win.addItem(item("Minimizar", #selector(NSWindow.performMiniaturize(_:)), "m"))
        win.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        for (title, menu) in [("Takes", app), ("Editar", edit), ("Visualizar", view), ("Janela", win)] {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = menu
            main.addItem(top)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    // MARK: diálogos do JavaScript

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancelar")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancelar")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // Links para fora do app abrem no navegador padrão.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: navegação e downloads

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if url.scheme == "takes" {
            decisionHandler(.cancel)
            if url.absoluteString == "takes:restart" { restartServer() }
            return
        }
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        if ["http", "https"].contains(url.scheme ?? ""), url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if disposition.lowercased().contains("attachment") || !navigationResponse.canShowMIMEType { return decisionHandler(.download) }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url) // o painel já pediu confirmação para substituir
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert()
        alert.messageText = "Não foi possível salvar o arquivo."
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }

    func webView(_ webView: WKWebView, webContentProcessDidTerminate: WKWebView) { reload() }

    // MARK: mensagens da página

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "copy", let text = body["text"] as? String {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
    }
}

extension String {
    var htmlEscaped: String {
        replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
