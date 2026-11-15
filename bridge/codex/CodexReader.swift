import Foundation

/// Deliberately closed: the reader cannot request start/resume/steer or Send.
enum CodexReadMethod: String, CaseIterable {
    case inventory = "thread/list"
    case metadata = "thread/read"
    case turns = "thread/turns/list"
    case items = "thread/items/list"
}
protocol CodexReaderTransport {
    func read(_ method: CodexReadMethod, parameters: [String: Any]) throws -> [String: Any]
}

enum CodexReaderFailure: String, Error {
    case invalidThread = "invalid_thread"
    case notInInventory = "not_in_current_account_inventory"
    case wrongThread = "thread_identity_mismatch"
    case invalidResponse = "invalid_response"
    case paginationLimit = "pagination_limit"
}

struct CodexReply: Codable, Equatable {
    let text: String
    let phase: String
    let turnId: String
    let itemId: String
    let turnStatus: String
    let truncated: Bool
}
struct CodexReaderSnapshot: Encodable {
    let ok = true
    let provider = "codex"
    let threadId: String
    let title: String
    /// Describes this app-server's runtime only; notLoaded is not an idle claim.
    let state: String
    let stateSource = "codex-app-server"
    let reply: CodexReply?
    let limited: Bool

    private enum CodingKeys: String, CodingKey { case ok, provider, threadId, title, state, stateSource, reply, limited }
    func encode(to encoder: Encoder) throws {
        var box = encoder.container(keyedBy: CodingKeys.self)
        try box.encode(ok, forKey: .ok); try box.encode(provider, forKey: .provider)
        try box.encode(threadId, forKey: .threadId); try box.encode(title, forKey: .title)
        try box.encode(state, forKey: .state); try box.encode(stateSource, forKey: .stateSource)
        try box.encode(limited, forKey: .limited)
        if let reply { try box.encode(reply, forKey: .reply) } else { try box.encodeNil(forKey: .reply) }
    }
}

enum CodexReaderPolicy {
    static let maximumTextCharacters = 8_000
    static let inventoryPageSize = 100
    static let inventoryPages = 20
    static let turnPageSize = 5
    static let turnPages = 3
    static let itemPageSize = 20
    static let itemPages = 5

    static func normalizedThread(_ raw: String) throws -> String {
        guard raw.utf8.count == 36, let uuid = UUID(uuidString: raw) else { throw CodexReaderFailure.invalidThread }
        return uuid.uuidString.lowercased()
    }
    static func identifier(_ raw: Any?) throws -> String {
        guard let id = raw as? String, !id.isEmpty, id.utf8.count <= 256,
              !id.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw CodexReaderFailure.invalidResponse }
        return id
    }
    static func rows(_ result: [String: Any], maximum: Int) throws -> [[String: Any]] {
        guard let rows = result["data"] as? [[String: Any]], rows.count <= maximum else { throw CodexReaderFailure.invalidResponse }
        return rows
    }
    static func nextCursor(_ result: [String: Any], seen: inout Set<String>) throws -> String? {
        guard let value = result["nextCursor"], !(value is NSNull) else { return nil }
        guard let cursor = value as? String, !cursor.isEmpty, cursor.utf8.count <= 4096,
              seen.insert(cursor).inserted else { throw CodexReaderFailure.invalidResponse }
        return cursor
    }
    static func state(_ value: Any?) -> String {
        guard let value = value as? [String: Any], let type = value["type"] as? String else { return "unknown" }
        switch type { case "active", "idle": return type; case "systemError": return "error"; default: return "unknown" }
    }
    static func reply(_ entry: [String: Any], turnID: String, turnStatus: String) throws -> CodexReply? {
        guard try identifier(entry["turnId"]) == turnID else { throw CodexReaderFailure.wrongThread }
        guard let item = entry["item"] as? [String: Any], let type = item["type"] as? String else { throw CodexReaderFailure.invalidResponse }
        guard type == "agentMessage" else { return nil }
        let itemID = try identifier(item["id"])
        guard let rawText = item["text"] as? String else { throw CodexReaderFailure.invalidResponse }
        // Respect a provider flag suppressing moderated text; never expose tool
        // output or hidden reasoning by treating every item as an assistant reply.
        if let moderation = item["moderation"] as? [String: Any], moderation["moderated"] as? Bool == true { return nil }
        let clean = String(rawText.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) || $0 == "\n" || $0 == "\t" })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let knownPhases = ["final_answer", "partial_answer", "commentary"]
        let phase = (item["phase"] as? String).flatMap { knownPhases.contains($0) ? $0 : nil } ?? "unknown"
        return CodexReply(text: String(clean.prefix(maximumTextCharacters)), phase: phase, turnId: turnID,
                          itemId: itemID, turnStatus: turnStatus, truncated: clean.count > maximumTextCharacters)
    }
    static func preferred(_ replies: [CodexReply]) -> CodexReply? {
        // Entries are newest first. Prefer the latest terminal answer over its
        // progress commentary, retaining the phase label if no final exists.
        for phase in ["final_answer", "partial_answer", "unknown", "commentary"] {
            if let reply = replies.first(where: { $0.phase == phase }) { return reply }
        }
        return nil
    }
}

struct CodexConversationReader {
    let transport: CodexReaderTransport

    private func inventoryTitle(_ threadID: String) throws -> String {
        var cursor: String?, seen = Set<String>()
        for _ in 0..<CodexReaderPolicy.inventoryPages {
            var params: [String: Any] = ["limit": CodexReaderPolicy.inventoryPageSize,
                "archived": false, "currentAccountOnly": true, "useStateDbOnly": true]
            if let cursor { params["cursor"] = cursor }
            let response = try transport.read(.inventory, parameters: params)
            for row in try CodexReaderPolicy.rows(response, maximum: CodexReaderPolicy.inventoryPageSize) {
                if let chat = CodexInventoryProtocol.chat(row), chat.id == threadID { return chat.name }
            }
            cursor = try CodexReaderPolicy.nextCursor(response, seen: &seen)
            if cursor == nil { throw CodexReaderFailure.notInInventory }
        }
        throw CodexReaderFailure.paginationLimit
    }

    func snapshot(threadID raw: String) throws -> CodexReaderSnapshot {
        let threadID = try CodexReaderPolicy.normalizedThread(raw)
        let inventoryName = try inventoryTitle(threadID)
        let metadata = try transport.read(.metadata, parameters: ["threadId": threadID, "includeTurns": false])
        guard let thread = metadata["thread"] as? [String: Any], let returned = thread["id"] as? String,
              (try? CodexReaderPolicy.normalizedThread(returned)) == threadID else { throw CodexReaderFailure.wrongThread }
        let title = (thread["name"] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : String($0.prefix(240)) } ?? inventoryName
        let content = try latestReply(threadID)
        // Account changes during the read must not leak a previously valid
        // account's reply. This check does not resume or load the thread.
        _ = try inventoryTitle(threadID)
        return CodexReaderSnapshot(threadId: threadID, title: title, state: CodexReaderPolicy.state(thread["status"]),
                                   reply: content.reply, limited: content.limited)
    }

    private func latestReply(_ threadID: String) throws -> (reply: CodexReply?, limited: Bool) {
        var cursor: String?, seenCursors = Set<String>(), seenTurns = Set<String>()
        for page in 0..<CodexReaderPolicy.turnPages {
            var params: [String: Any] = ["threadId": threadID, "limit": CodexReaderPolicy.turnPageSize,
                                        "sortDirection": "desc", "itemsView": "notLoaded"]
            if let cursor { params["cursor"] = cursor }
            let result = try transport.read(.turns, parameters: params)
            for turn in try CodexReaderPolicy.rows(result, maximum: CodexReaderPolicy.turnPageSize) {
                let id = try CodexReaderPolicy.identifier(turn["id"])
                guard seenTurns.insert(id).inserted else { continue }
                guard let status = turn["status"] as? String,
                      ["completed", "inProgress", "interrupted", "failed"].contains(status) else { throw CodexReaderFailure.invalidResponse }
                let read = try readTurn(threadID, turnID: id, status: status)
                if read.reply != nil || read.limited { return read }
            }
            cursor = try CodexReaderPolicy.nextCursor(result, seen: &seenCursors)
            if cursor == nil { return (nil, false) }
            if page == CodexReaderPolicy.turnPages - 1 { return (nil, true) }
        }
        return (nil, true)
    }

    private func readTurn(_ threadID: String, turnID: String, status: String) throws -> (reply: CodexReply?, limited: Bool) {
        var cursor: String?, seen = Set<String>(), itemIDs = Set<String>(), replies = [CodexReply]()
        for page in 0..<CodexReaderPolicy.itemPages {
            var params: [String: Any] = ["threadId": threadID, "turnId": turnID,
                                        "limit": CodexReaderPolicy.itemPageSize, "sortDirection": "desc"]
            if let cursor { params["cursor"] = cursor }
            let result = try transport.read(.items, parameters: params)
            for entry in try CodexReaderPolicy.rows(result, maximum: CodexReaderPolicy.itemPageSize) {
                if let reply = try CodexReaderPolicy.reply(entry, turnID: turnID, turnStatus: status), itemIDs.insert(reply.itemId).inserted {
                    replies.append(reply)
                }
            }
            if let final = replies.first(where: { $0.phase == "final_answer" }) { return (final, false) }
            cursor = try CodexReaderPolicy.nextCursor(result, seen: &seen)
            if cursor == nil { return (CodexReaderPolicy.preferred(replies), false) }
            if page == CodexReaderPolicy.itemPages - 1 { return (CodexReaderPolicy.preferred(replies), true) }
        }
        return (CodexReaderPolicy.preferred(replies), true)
    }
}
