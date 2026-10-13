// AI Term's notification helper: posts one notification from its argv and exits.
// The daemon launches it through Launch Services (`open -n -g -a`), so macOS shows and permits it as "AI Term".
// No click handling yet: a click relaunches the app with no argv, which exits with the fixed argument error.
import AppKit
import UserNotifications
import Foundation
import Darwin

struct Arguments: Sendable {
    let sessionID: String
    let title: String
    let body: String
    let check: Bool

    static func uuid(_ value: String) -> Bool {
        value.utf8.count == 36 && UUID(uuidString: value) != nil
    }
    static func text(_ value: String, limit: Int) -> Bool {
        // Scalar bounds also bound UTF-8 bytes and disallow invisible control/format characters.
        !value.isEmpty && value.unicodeScalars.count <= limit && !value.unicodeScalars.contains {
            CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format
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

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); Darwin.exit(code)
}

// The first launch waits for the user to answer the permission prompt; never linger longer than this.
let maximumLifetime: Duration = .seconds(120)
// Notification Center takes the request on add(); a short wait lets the banner and sound start before exit.
let exitDelay: Duration = .seconds(2)

@MainActor final class NotifierDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let arguments: Arguments
    init(_ arguments: Arguments) { self.arguments = arguments }
    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { await self.post() }
        Task {
            do { try await Task.sleep(for: maximumLifetime) } catch { fail("Notifier lifetime failed", code: 1) }
            fail("Notifier timed out", code: 1)
        }
    }
    func post() async {
        let center = UNUserNotificationCenter.current()
        let allowed: Bool
        do { allowed = try await center.requestAuthorization(options: [.alert, .sound]) }
        catch { fail("Notification authorization failed", code: 1) }
        guard allowed else { fail("Notification permission not granted", code: 1) }
        let content = UNMutableNotificationContent()
        content.title = arguments.title; content.body = arguments.body; content.sound = .default
        content.threadIdentifier = arguments.sessionID
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        do { try await center.add(request) } catch { fail("Notification post failed", code: 1) }
        do { try await Task.sleep(for: exitDelay) } catch { fail("Notifier exit wait failed", code: 1) }
        Darwin.exit(0)
    }
    // The helper is never frontmost, but if it is, the banner and sound still show.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}

@main @MainActor enum NotifierMain {
    static func main() {
        guard let arguments = Arguments.parse(Array(CommandLine.arguments.dropFirst())) else { fail("Invalid notifier arguments", code: 2) }
        if arguments.check { return }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = NotifierDelegate(arguments)
        app.delegate = delegate; UNUserNotificationCenter.current().delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
