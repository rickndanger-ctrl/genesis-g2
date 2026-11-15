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
struct CodexConversationMessage: Codable, Equatable {
    let role: String
    let text: String
    let phase: String?
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
    let turns: [CodexConversationMessage]
    let turnsTruncated: Bool

    private enum CodingKeys: String, CodingKey { case ok, provider, threadId, title, state, stateSource, reply, limited, turns, turnsTruncated }
    func encode(to encoder: Encoder) throws {
        var box = encoder.container(keyedBy: CodingKeys.self)
        try box.encode(ok, forKey: .ok); try box.encode(provider, forKey: .provider)
        try box.encode(threadId, forKey: .threadId); try box.encode(title, forKey: .title)
        try box.encode(state, forKey: .state); try box.encode(stateSource, forKey: .stateSource)
        try box.encode(limited, forKey: .limited)
        try box.encode(turns, forKey: .turns); try box.encode(turnsTruncated, forKey: .turnsTruncated)
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
    static let conversationMessages = 6
    static let conversationScalars = 16_000
    static let conversationMessageScalars = 8_000
    static let conversationTurnLimit = 3
    // Reuse the legacy reply's small pages, then search farther back through
    // tool-heavy turns without spending one RPC per twenty non-message items.
    static let conversationExpandedPageSize = 100
    static let conversationItemPageLimit = 13

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
        if let role = item["role"], !(role is NSNull), role as? String != "assistant" { return nil }
        if ["analysis", "reasoning", "hidden"].contains(item["phase"] as? String ?? "") || item["hidden"] as? Bool == true || item["visibility"] as? String == "hidden" { return nil }
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
    private static func userText(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Known Codex transport wrappers are not human conversation. Do not
        // expose file metadata, AGENTS instructions, environment, or duplicated
        // realtime transcript tails as though the user had spoken them.
        if text.hasPrefix("# AGENTS.md instructions") || text.hasPrefix("<environment_context>") || text.hasPrefix("<permissions instructions>") { return nil }
        if text.hasPrefix("<realtime_delegation>") {
            guard !text.contains("<source>transcript_tail_flush</source>"),
                  let start = text.range(of: "<input>"), let end = text.range(of: "</input>", range: start.upperBound..<text.endIndex) else { return nil }
            text = String(text[start.upperBound..<end.lowerBound])
        } else if text.hasPrefix("<send_user_message_question_reply>") {
            guard let start = text.range(of: ">"), let end = text.range(of: "</send_user_message_question_reply>"),
                  let data = String(text[start.upperBound..<end.lowerBound]).data(using: .utf8),
                  let replies = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
            text = replies.compactMap { $0["answer"] as? String }.joined(separator: "\n")
        } else if text.hasPrefix("# Files mentioned by the user:") {
            guard let request = text.range(of: "## My request:") else { return nil }
            text = String(text[request.upperBound...])
            text = text.replacingOccurrences(of: "(?s)<image\\b[^>]*>.*?</image>", with: "", options: .regularExpression)
            text = text.replacingOccurrences(of: "<image\\b[^>]*>", with: "", options: .regularExpression)
        }
        text = String(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) || $0 == "\n" || $0 == "\t" }).trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
    static func conversationMessage(_ entry: [String: Any], turnID: String, turnStatus: String) throws -> (id: String, message: CodexConversationMessage)? {
        guard try identifier(entry["turnId"]) == turnID else { throw CodexReaderFailure.wrongThread }
        guard let item = entry["item"] as? [String: Any], let type = item["type"] as? String else { throw CodexReaderFailure.invalidResponse }
        guard ["userMessage", "agentMessage"].contains(type) else { return nil }
        let expectedRole = type == "userMessage" ? "user" : "assistant"
        if let role = item["role"], !(role is NSNull), role as? String != expectedRole { return nil }
        if item["hidden"] as? Bool == true || item["visibility"] as? String == "hidden" { return nil }
        if let moderation = item["moderation"] as? [String: Any], moderation["moderated"] as? Bool == true { return nil }
        if type == "agentMessage" {
            guard let reply = try reply(entry, turnID: turnID, turnStatus: turnStatus) else { return nil }
            return (reply.itemId, CodexConversationMessage(role: "assistant", text: reply.text, phase: reply.phase, truncated: reply.truncated))
        }
        guard type == "userMessage" else { return nil }
        let id = try identifier(item["id"])
        // Current desktop uses content; some app-server versions use input.
        // Never descend into arbitrary fields or fall back to raw item.text.
        guard let parts = (item["content"] ?? item["input"]) as? [[String: Any]] else { return nil }
        let texts = parts.compactMap { part -> String? in
            guard part["type"] as? String == "text", let text = part["text"] as? String else { return nil }
            if let role = part["role"] as? String, role != "user" { return nil }
            return userText(text)
        }
        let text = texts.joined(separator: "\n")
        guard !text.isEmpty else { return nil }
        return (id, CodexConversationMessage(role: "user", text: text, phase: nil, truncated: false))
    }
    static func boundedConversation(_ newestFirst: [CodexConversationMessage]) -> (messages: [CodexConversationMessage], truncated: Bool) {
        // Reserve budget for the newest user and assistant before spending any
        // on older commentary. Final output preserves actual chronological order.
        let required = ["user", "assistant"].compactMap { role in newestFirst.firstIndex { $0.role == role } }.sorted()
        var chosen = Set(required)
        for index in newestFirst.indices where chosen.count < conversationMessages { chosen.insert(index) }
        var remaining = conversationScalars, result: [Int: CodexConversationMessage] = [:]
        for index in required + chosen.sorted().filter({ !required.contains($0) }) {
            guard remaining > 0 else { continue }
            let message = newestFirst[index], limit = min(conversationMessageScalars, remaining)
            let scalars = message.text.unicodeScalars
            let text = String(String.UnicodeScalarView(scalars.prefix(limit)))
            remaining -= text.unicodeScalars.count
            result[index] = CodexConversationMessage(role: message.role, text: text, phase: message.phase, truncated: message.truncated || scalars.count > limit)
        }
        let messages = result.keys.sorted(by: >).compactMap { result[$0] }
        return (messages, result.count < newestFirst.count || messages.contains { $0.truncated })
    }
}

/// Reuse read-only pages within one snapshot. Account inventory is deliberately
/// never cached: its final membership check must observe a fresh account state.
private final class CodexSnapshotReadCache: CodexReaderTransport {
    let base: CodexReaderTransport
    private var pages: [String: [String: Any]] = [:]
    init(_ base: CodexReaderTransport) { self.base = base }
    func read(_ method: CodexReadMethod, parameters: [String: Any]) throws -> [String: Any] {
        guard method == .turns || method == .items else { return try base.read(method, parameters: parameters) }
        let key = method.rawValue + String(data: try JSONSerialization.data(withJSONObject: parameters, options: [.sortedKeys]), encoding: .utf8)!
        if let result = pages[key] { return result }
        let result = try base.read(method, parameters: parameters); pages[key] = result; return result
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
        try CodexConversationReader(transport: CodexSnapshotReadCache(transport)).readSnapshot(threadID: raw)
    }
    private func readSnapshot(threadID raw: String) throws -> CodexReaderSnapshot {
        let threadID = try CodexReaderPolicy.normalizedThread(raw)
        let inventoryName = try inventoryTitle(threadID)
        let metadata = try transport.read(.metadata, parameters: ["threadId": threadID, "includeTurns": false])
        guard let thread = metadata["thread"] as? [String: Any], let returned = thread["id"] as? String,
              (try? CodexReaderPolicy.normalizedThread(returned)) == threadID else { throw CodexReaderFailure.wrongThread }
        let title = (thread["name"] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : String($0.prefix(240)) } ?? inventoryName
        let content = try latestReply(threadID)
        let conversation = try recentConversation(threadID)
        // Account changes during the read must not leak a previously valid
        // account's reply. This check does not resume or load the thread.
        _ = try inventoryTitle(threadID)
        return CodexReaderSnapshot(threadId: threadID, title: title, state: CodexReaderPolicy.state(thread["status"]),
                                   reply: content.reply, limited: content.limited, turns: conversation.messages, turnsTruncated: conversation.truncated)
    }

    private func recentConversation(_ threadID: String) throws -> (messages: [CodexConversationMessage], truncated: Bool) {
        var turnCursor: String?, turnCursors = Set<String>(), turns = Set<String>(), items = Set<String>()
        var messages = [CodexConversationMessage](), readTurns = 0, itemPageReads = 0
        func bounded(_ limited: Bool) -> (messages: [CodexConversationMessage], truncated: Bool) {
            let result = CodexReaderPolicy.boundedConversation(messages)
            return (result.messages, limited || result.truncated)
        }
        for turnPage in 0..<CodexReaderPolicy.turnPages {
            var params: [String: Any] = ["threadId": threadID, "limit": CodexReaderPolicy.turnPageSize, "sortDirection": "desc", "itemsView": "notLoaded"]
            if let turnCursor { params["cursor"] = turnCursor }
            let response = try transport.read(.turns, parameters: params)
            let rows = try CodexReaderPolicy.rows(response, maximum: CodexReaderPolicy.turnPageSize)
            for (index, turn) in rows.enumerated() {
                let turnID = try CodexReaderPolicy.identifier(turn["id"])
                guard turns.insert(turnID).inserted else { continue }
                guard let status = turn["status"] as? String, ["completed", "inProgress", "interrupted", "failed"].contains(status) else { throw CodexReaderFailure.invalidResponse }
                readTurns += 1
                var itemCursor: String?, itemCursors = Set<String>()
                for itemPage in 0..<CodexReaderPolicy.conversationItemPageLimit {
                    let pageSize = itemPage < CodexReaderPolicy.itemPages ? CodexReaderPolicy.itemPageSize : CodexReaderPolicy.conversationExpandedPageSize
                    var itemParams: [String: Any] = ["threadId": threadID, "turnId": turnID, "limit": pageSize, "sortDirection": "desc"]
                    if let itemCursor { itemParams["cursor"] = itemCursor }
                    let result = try transport.read(.items, parameters: itemParams); itemPageReads += 1
                    for entry in try CodexReaderPolicy.rows(result, maximum: pageSize) {
                        if let value = try CodexReaderPolicy.conversationMessage(entry, turnID: turnID, turnStatus: status), items.insert(turnID + ":" + value.id).inserted {
                            messages.append(value.message)
                        }
                    }
                    itemCursor = try CodexReaderPolicy.nextCursor(result, seen: &itemCursors)
                    let hasPair = messages.contains { $0.role == "user" } && messages.contains { $0.role == "assistant" }
                    let moreTurns = index < rows.count - 1 || !(response["nextCursor"] is NSNull) && response["nextCursor"] != nil
                    if messages.count >= CodexReaderPolicy.conversationMessages && hasPair { return bounded(itemCursor != nil || moreTurns) }
                    if itemPageReads >= CodexReaderPolicy.conversationItemPageLimit { return bounded(itemCursor != nil || moreTurns) }
                    if itemCursor == nil { break }
                }
                if readTurns >= CodexReaderPolicy.conversationTurnLimit { return bounded(index < rows.count - 1 || response["nextCursor"] as? String != nil) }
            }
            turnCursor = try CodexReaderPolicy.nextCursor(response, seen: &turnCursors)
            if turnCursor == nil { return bounded(false) }
            if turnPage == CodexReaderPolicy.turnPages - 1 { return bounded(true) }
        }
        return bounded(true)
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
