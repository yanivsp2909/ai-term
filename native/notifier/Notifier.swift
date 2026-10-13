// AI Term's notification helper: posts one notification from its argv and exits.
// The daemon launches it through Launch Services (`open -n -g -a`), so macOS shows and permits it as "AI Term".
// A click on a banner reaches this app's delegate: either the posting instance, if it is still running, or a fresh
// instance macOS launches with no argv (a cold click). Either way the session id comes from the notification's userInfo,
// is validated as a UUID and is sent as {"clicked":"<uuid>"} to the daemon's fixed private socket. Nothing else is sent.
import AppKit
import UserNotifications
import Foundation
import Darwin

struct Arguments: Sendable {
    let sessionID: String
    let title: String
    let body: String
    let check: Bool

    static let refused: Set<Unicode.GeneralCategory> = [.format, .lineSeparator, .paragraphSeparator, .privateUse, .surrogate]
    static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value) != nil
    }
    static func text(_ value: String, limit: Int) -> Bool {
        // Scalar bounds also bound UTF-8 bytes. The same classes the daemon removes from names are refused here:
        // controls, format (bidi), line/paragraph separators, private use and surrogates. Unassigned code points pass:
        // macOS's Unicode tables can lag Node's, and a name the daemon accepted must not be dropped silently here.
        !value.isEmpty && value.unicodeScalars.count <= limit && !value.unicodeScalars.contains {
            CharacterSet.controlCharacters.contains($0) || refused.contains($0.properties.generalCategory)
        }
    }
    static func parse(_ argv: [String]) -> Arguments? {
        let values = ["--session", "--title", "--body"], flags = ["--check"]
        var fields: [String: String] = [:], enabled = Set<String>(), index = 0
        while index < argv.count {
            let name = argv[index]
            if flags.contains(name) {
                guard enabled.insert(name).inserted else { return nil }
            } else {
                guard values.contains(name), fields[name] == nil, index + 1 < argv.count else { return nil }
                index += 1; fields[name] = argv[index]
            }
            index += 1
        }
        guard let id = fields["--session"], uuid(id),
              let title = fields["--title"], text(title, limit: 80),
              let body = fields["--body"], text(body, limit: 200) else { return nil }
        return Arguments(sessionID: id.lowercased(), title: title, body: body, check: enabled.contains("--check"))
    }
}

// The click route: a fixed socket inside the private AI Term directory. A cold launch has no argv, so the path can't come
// from the daemon; AI_TERM_HOME (absolute) overrides the home exactly as it does for the daemon.
enum ClickRoute {
    enum Entry { case ok, missing, unsafe }
    static func home() -> String? {
        if let value = ProcessInfo.processInfo.environment["AI_TERM_HOME"] { return value.hasPrefix("/") ? value : nil }
        guard let user = getpwuid(getuid()), let directory = user.pointee.pw_dir else { return nil }
        return String(cString: directory) + "/.ai-term"
    }
    // lstat never follows a symlink: a link in place of the directory or the socket is refused, not followed.
    static func check(_ path: String, type: mode_t, mode: mode_t) -> Entry {
        var info = stat()
        guard lstat(path, &info) == 0 else { return errno == ENOENT ? .missing : .unsafe }
        return info.st_mode & S_IFMT == type && info.st_uid == getuid() && info.st_mode & 0o777 == mode ? .ok : .unsafe
    }
    static func milliseconds(until deadline: ContinuousClock.Instant) -> Int32 {
        let left = ContinuousClock.now.duration(to: deadline).components
        return Int32(max(0, min(1000, left.seconds * 1000 + left.attoseconds / 1_000_000_000_000_000)))
    }
    // Returns nil on success, otherwise one fixed error text. The whole send is bounded to one second.
    static func send(_ sessionID: String) -> String? {
        let unsafe = "Click socket unsafe", unavailable = "Click socket unavailable", failed = "Click send failed"
        guard let root = home() else { return unsafe }
        let run = root + "/run", path = run + "/click.sock"
        for (entry, type, mode) in [(root, S_IFDIR, mode_t(0o700)), (run, S_IFDIR, mode_t(0o700)), (path, S_IFSOCK, mode_t(0o600))] {
            switch check(entry, type: type, mode: mode) { case .ok: continue; case .missing: return unavailable; case .unsafe: return unsafe }
        }
        var address = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return unsafe }
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in for (index, byte) in bytes.enumerated() { buffer[index] = byte } }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return failed }
        defer { close(fd) }
        var on: Int32 = 1
        // A daemon that went away must never kill the helper with SIGPIPE.
        guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size)) == 0,
              fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) == 0 else { return failed }
        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if connected != 0 {
            guard errno == EINPROGRESS || errno == EAGAIN else { return unavailable }
            var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0), error: Int32 = 0, length = socklen_t(MemoryLayout<Int32>.size)
            guard poll(&ready, 1, milliseconds(until: deadline)) == 1, getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0, error == 0 else { return unavailable }
        }
        // The listener must be this user's own process: same owner as the socket file.
        var peer: uid_t = 0, group: gid_t = 0
        guard getpeereid(fd, &peer, &group) == 0, peer == getuid() else { return unsafe }
        let payload = Array("{\"clicked\":\"\(sessionID)\"}\n".utf8)
        var sent = 0
        while sent < payload.count {
            var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
            guard poll(&ready, 1, milliseconds(until: deadline)) == 1 else { return failed }
            let written = payload[sent...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            if written < 0 { if errno == EAGAIN || errno == EINTR { continue }; return failed }
            sent += written
        }
        shutdown(fd, SHUT_WR)
        return nil
    }
    // A click from the delegate or from --click: only a valid UUID ever reaches the socket.
    static func deliver(_ value: String?) -> Never {
        guard let value, Arguments.uuid(value) else { fail("Invalid click session", code: 2) }
        if let error = send(value.lowercased()) { fail(error, code: 1) }
        Darwin.exit(0)
    }
}

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); Darwin.exit(code)
}

// The first launch waits for the user to answer the permission prompt; never linger longer than this.
let maximumLifetime: Duration = .seconds(120)
// Notification Center takes the request on add(); a short wait lets the banner and sound start before exit.
let exitDelay: Duration = .seconds(2)
// A cold click is delivered while the relaunched app finishes launching; without one, it was opened some other way.
let clickWait: Duration = .seconds(3)

@MainActor final class NotifierDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    // nil: a cold launch with no argv, which only waits for a click.
    let arguments: Arguments?
    init(_ arguments: Arguments?) { self.arguments = arguments }
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let arguments else {
            Task {
                do { try await Task.sleep(for: clickWait) } catch { fail("Notifier lifetime failed", code: 1) }
                fail("Invalid notifier arguments", code: 2)
            }
            return
        }
        Task { await self.post(arguments) }
        Task {
            do { try await Task.sleep(for: maximumLifetime) } catch { fail("Notifier lifetime failed", code: 1) }
            fail("Notifier timed out", code: 1)
        }
    }
    func post(_ arguments: Arguments) async {
        let center = UNUserNotificationCenter.current()
        let allowed: Bool
        do { allowed = try await center.requestAuthorization(options: [.alert, .sound]) }
        catch { fail("Notification authorization failed", code: 1) }
        guard allowed else { fail("Notification permission not granted", code: 1) }
        let content = UNMutableNotificationContent()
        content.title = arguments.title; content.body = arguments.body; content.sound = .default
        content.threadIdentifier = arguments.sessionID
        content.userInfo = ["session": arguments.sessionID]
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        do { try await center.add(request) } catch { fail("Notification post failed", code: 1) }
        do { try await Task.sleep(for: exitDelay) } catch { fail("Notifier exit wait failed", code: 1) }
        Darwin.exit(0)
    }
    // The helper is never frontmost, but if it is, the banner and sound still show.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
    // Only the banner's own click opens the agent; any other action (e.g. a dismiss) does nothing.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        ClickRoute.deliver(response.notification.request.content.userInfo["session"] as? String)
    }
}

@main @MainActor enum NotifierMain {
    static func main() async {
        if Array(CommandLine.arguments.dropFirst()) == ["--status"] {
            // Reads authorization without ever presenting the requestAuthorization prompt.
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            let word: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: word = "allowed"
            case .denied: word = "denied"
            case .notDetermined: word = "not-asked"
            @unknown default: word = "unknown"
            }
            FileHandle.standardOutput.write(Data((word + "\n").utf8))
            return
        }
        let argv = Array(CommandLine.arguments.dropFirst())
        // The same send a banner click performs, for a given session (tests and manual checks).
        if argv.first == "--click" {
            guard argv.count == 2, Arguments.uuid(argv[1]) else { fail("Invalid notifier arguments", code: 2) }
            ClickRoute.deliver(argv[1])
        }
        var arguments: Arguments? = nil
        if !argv.isEmpty {
            guard let parsed = Arguments.parse(argv) else { fail("Invalid notifier arguments", code: 2) }
            if parsed.check { return }
            arguments = parsed
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = NotifierDelegate(arguments)
        // Both delegates are set before app.run(): a cold click is delivered while the app finishes launching.
        app.delegate = delegate
        UNUserNotificationCenter.current().delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
