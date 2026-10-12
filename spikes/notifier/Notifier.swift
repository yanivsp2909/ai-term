import AppKit
import UserNotifications
import Foundation
import Darwin

enum SpikeError: Error { case arguments, callback }

struct Arguments: Sendable {
    let sessionID: String
    let title: String
    let body: String
    let root: String
    let socket: String
    let lifetime: Int
    let exitAfterPost: Bool
    let check: Bool
    let probeClick: Bool

    static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value) != nil
    }
    static func text(_ value: String, limit: Int) -> Bool {
        // Scalar bounds also bound UTF-8 bytes and disallow invisible control/format characters.
        !value.isEmpty && value.unicodeScalars.count <= limit && !value.unicodeScalars.contains {
            CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format
        }
    }
    static func parse(_ argv: [String]) throws -> Arguments {
        let values = ["--session", "--title", "--body", "--temp-dir", "--socket", "--lifetime"]
        let flags = ["--exit-after-post", "--check", "--probe-click"]
        var fields: [String: String] = [:], enabled = Set<String>(), index = 0
        while index < argv.count {
            let name = argv[index]
            if flags.contains(name) {
                guard enabled.insert(name).inserted else { throw SpikeError.arguments }
            } else {
                guard values.contains(name), fields[name] == nil, index + 1 < argv.count else { throw SpikeError.arguments }
                index += 1; fields[name] = argv[index]
            }
            index += 1
        }
        guard let id = fields["--session"], uuid(id),
              let title = fields["--title"], text(title, limit: 80),
              let body = fields["--body"], text(body, limit: 200),
              let root = fields["--temp-dir"], let socket = fields["--socket"],
              root.hasPrefix("/private/tmp/ai-term-notifier-"),
              !root.dropFirst("/private/tmp/ai-term-notifier-".count).isEmpty,
              root.dropFirst("/private/tmp/ai-term-notifier-".count).allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }),
              socket == root + "/click.sock", socket.utf8.count < 104,
              let lifetime = Int(fields["--lifetime"] ?? "120"), (5...600).contains(lifetime),
              fields["--lifetime"] == nil || String(lifetime) == fields["--lifetime"],
              !(enabled.contains("--check") && enabled.contains("--probe-click")) else { throw SpikeError.arguments }
        let result = Arguments(sessionID: id.lowercased(), title: title, body: body, root: root, socket: socket,
                               lifetime: lifetime, exitAfterPost: enabled.contains("--exit-after-post"),
                               check: enabled.contains("--check"), probeClick: enabled.contains("--probe-click"))
        try result.validatePaths()
        return result
    }
    func validatePaths() throws {
        var directory = stat(), endpoint = stat()
        guard lstat(root, &directory) == 0, directory.st_mode & S_IFMT == S_IFDIR,
              directory.st_uid == getuid(), directory.st_mode & 0o777 == 0o700,
              lstat(socket, &endpoint) == 0, endpoint.st_mode & S_IFMT == S_IFSOCK,
              endpoint.st_uid == getuid(), endpoint.st_mode & 0o777 == 0o600 else { throw SpikeError.arguments }
    }
}

func diagnostic(_ event: String, _ values: [String: String] = [:]) {
    let record = ["event": event, "at": ISO8601DateFormatter().string(from: Date())].merging(values) { _, right in right }
    if let data = try? JSONSerialization.data(withJSONObject: record, options: .sortedKeys) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
func fixedError(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }

// The only bytes sent are a revalidated UUID. Never execute or forward title/body as a command.
func sendClick(_ sessionID: String, arguments: Arguments) throws {
    guard Arguments.uuid(sessionID) else { throw SpikeError.callback }
    try arguments.validatePaths()
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw SpikeError.callback }
    defer { Darwin.close(fd) }
    var noPipe: Int32 = 1, timeout = timeval(tv_sec: 1, tv_usec: 0)
    guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noPipe, socklen_t(MemoryLayout.size(ofValue: noPipe))) == 0,
          setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0 else { throw SpikeError.callback }
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(arguments.socket.utf8) + [0]
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let length = socklen_t(MemoryLayout<sockaddr_un>.size); address.sun_len = UInt8(length)
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, length) }
    }
    guard connected == 0 else { throw SpikeError.callback }
    let data = try JSONSerialization.data(withJSONObject: ["clicked": sessionID.lowercased()]) + Data([10])
    try data.withUnsafeBytes { buffer in
        guard let base = buffer.baseAddress else { throw SpikeError.callback }
        var sent = 0
        while sent < buffer.count {
            let count = Darwin.send(fd, base.advanced(by: sent), buffer.count - sent, 0)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw SpikeError.callback }; sent += count
        }
    }
}

@MainActor final class NotifierDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let arguments: Arguments
    init(_ arguments: Arguments) { self.arguments = arguments }
    func applicationDidFinishLaunching(_ notification: Notification) {
        diagnostic("launched", ["pid": String(getpid()), "bundle": Bundle.main.bundleIdentifier ?? "missing"])
        Task {
            do {
                let center = UNUserNotificationCenter.current()
                let allowed: Bool
                do { allowed = try await center.requestAuthorization(options: [.alert, .sound]) }
                catch { diagnostic("authorization-failed", ["code": String((error as NSError).code), "userNotificationsDomain": String((error as NSError).domain == UNErrorDomain)]); fixedError("Notification authorization failed"); Darwin.exit(1) }
                let settings = await center.notificationSettings()
                diagnostic("authorization", ["granted": String(allowed), "status": String(settings.authorizationStatus.rawValue),
                                             "sound": String(settings.soundSetting.rawValue), "alert": String(settings.alertSetting.rawValue)])
                guard allowed else { fixedError("Notification permission not granted"); Darwin.exit(1) }
                let content = UNMutableNotificationContent()
                content.title = arguments.title; content.body = arguments.body; content.sound = .default
                content.userInfo = ["sessionId": arguments.sessionID]; content.threadIdentifier = arguments.sessionID
                let request = UNNotificationRequest(identifier: UUID().uuidString, content: content,
                                                    trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
                do { try await center.add(request) }
                catch { diagnostic("post-failed"); fixedError("Notification post failed"); Darwin.exit(1) }
                diagnostic("posted", ["session": arguments.sessionID])
                if arguments.exitAfterPost {
                    try await Task.sleep(for: .seconds(3)); diagnostic("exit-after-post"); NSApplication.shared.terminate(nil)
                }
            } catch { fixedError("Notification operation failed"); Darwin.exit(1) }
        }
        Task {
            do { try await Task.sleep(for: .seconds(arguments.lifetime)); diagnostic("lifetime-ended"); NSApplication.shared.terminate(nil) }
            catch { fixedError("Notifier lifetime failed") }
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        diagnostic("foreground-presentation"); return [.banner, .list, .sound]
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let sessionID = response.notification.request.content.userInfo["sessionId"] as? String
        await MainActor.run {
            guard let sessionID, Arguments.uuid(sessionID) else { fixedError("Invalid notification response"); return }
            do { try sendClick(sessionID, arguments: self.arguments); diagnostic("clicked", ["session": sessionID]) }
            catch { fixedError("Notification click callback failed") }
        }
    }
}

@main @MainActor enum NotifierMain {
    static func main() {
        let arguments: Arguments
        do { arguments = try Arguments.parse(Array(CommandLine.arguments.dropFirst())) }
        catch { fixedError("Invalid notifier arguments"); Darwin.exit(2) }
        if arguments.check { diagnostic("arguments-valid"); return }
        if arguments.probeClick {
            do { try sendClick(arguments.sessionID, arguments: arguments); diagnostic("probe-click-sent") }
            catch { fixedError("Notification click callback failed"); Darwin.exit(1) }; return
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = NotifierDelegate(arguments)
        app.delegate = delegate; UNUserNotificationCenter.current().delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
