import Foundation

@main struct CodexReaderCLI {
    static func main() {
        do {
            let args = CommandLine.arguments
            guard args.count == 3, args[1] == "--thread" else { throw CodexReaderFailure.invalidThread }
            let thread = try CodexReaderPolicy.normalizedThread(args[2])
            let environment = ProcessInfo.processInfo.environment
            let home: URL
            if let override = environment["CODEX_HOME"], !override.isEmpty {
                guard override.hasPrefix("/") else { throw CodexInventoryError.unavailable }
                home = URL(fileURLWithPath: override, isDirectory: true)
            } else {
                home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex", isDirectory: true)
            }
            let socket = try CodexMetadataSocket(path: home.appendingPathComponent("app-server-control/app-server-control.sock").path)
            try socket.initialize()
            let snapshot = try CodexConversationReader(transport: socket).snapshot(threadID: thread)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            FileHandle.standardOutput.write(try encoder.encode(snapshot))
            FileHandle.standardOutput.write(Data([10]))
        } catch {
            let code: String
            if let failure = error as? CodexReaderFailure { code = failure.rawValue }
            else if let failure = error as? CodexInventoryError {
                switch failure {
                case .timeout: code = "timeout"
                case .tooLarge: code = "response_too_large"
                case .rejected: code = "history_unavailable"
                case .invalidResponse: code = "invalid_response"
                case .unavailable: code = "service_unavailable"
                }
            } else { code = "reader_failed" }
            let result: [String: Any] = ["ok": false, "error": ["code": code,
                "message": "The selected Codex conversation could not be read. No conversation was started or changed."]]
            if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
                FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
            }
            exit(1)
        }
    }
}
