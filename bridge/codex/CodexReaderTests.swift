import Foundation

final class FixtureTransport: CodexReaderTransport {
    var calls: [(CodexReadMethod, [String: Any])] = []
    var handler: (CodexReadMethod, [String: Any]) throws -> [String: Any]
    init(_ handler: @escaping (CodexReadMethod, [String: Any]) throws -> [String: Any]) { self.handler = handler }
    func read(_ method: CodexReadMethod, parameters: [String: Any]) throws -> [String: Any] {
        calls.append((method, parameters)); return try handler(method, parameters)
    }
}

@main struct CodexReaderTests {
    static let target = "11111111-1111-4111-8111-111111111111"
    static let other = "22222222-2222-4222-8222-222222222222"
    static func page(_ rows: [[String: Any]], _ cursor: String? = nil) -> [String: Any] {
        ["data": rows, "nextCursor": cursor as Any? ?? NSNull()]
    }
    static func inventory(_ id: String = target) -> [String: Any] { ["id": id, "name": "Fixture conversation"] }
    static func metadata(_ id: String = target, state: String = "idle") -> [String: Any] {
        ["thread": ["id": id, "name": "Fixture conversation", "status": ["type": state]]]
    }
    static func turn(_ id: String = "turn-a", _ status: String = "completed") -> [String: Any] { ["id": id, "status": status] }
    static func message(_ text: String, phase: String? = "final_answer", turn: String = "turn-a", id: String = "message-a") -> [String: Any] {
        ["turnId": turn, "item": ["id": id, "type": "agentMessage", "text": text, "phase": phase as Any? ?? NSNull()]]
    }
    static func standard(_ items: [[String: Any]], state: String = "idle") -> FixtureTransport {
        FixtureTransport { method, _ in
            switch method {
            case .inventory: return page([inventory()])
            case .metadata: return metadata(state: state)
            case .turns: return page([turn()])
            case .items: return page(items)
            }
        }
    }
    static func main() throws {
        var count = 0
        func expect(_ value: @autoclosure () throws -> Bool, _ label: String) rethrows {
            count += 1
            guard try value() else { fatalError("FAIL: \(label)") }
        }
        func failure(_ expected: CodexReaderFailure, _ block: () throws -> Void, _ label: String) {
            count += 1
            do { try block(); fatalError("FAIL: \(label) unexpectedly succeeded") }
            catch let error as CodexReaderFailure { guard error == expected else { fatalError("FAIL: \(label): wrong failure") } }
            catch { fatalError("FAIL: \(label): wrong error class") }
        }

        expect(Set(CodexReadMethod.allCases.map(\.rawValue)) == Set(["thread/list", "thread/read", "thread/turns/list", "thread/items/list"]), "only read methods are expressible")
        try expect(CodexReaderPolicy.normalizedThread(target.uppercased()) == target, "exact UUID is normalized")
        for id in ["", "new", "Fixture conversation", "../history", target + " ", String(repeating: "x", count: 200)] {
            failure(.invalidThread, { _ = try CodexReaderPolicy.normalizedThread(id) }, "invalid thread does not become a fallback")
        }
        let baseline = standard([message("Final fixture answer")])
        let result = try CodexConversationReader(transport: baseline).snapshot(threadID: target)
        expect(result.threadId == target && result.reply?.text == "Final fixture answer", "exact requested thread response")
        expect(result.reply?.phase == "final_answer" && result.state == "idle", "phase and observed server state retained")
        expect(baseline.calls.filter { $0.0 == .inventory }.count == 2, "current-account membership checked before and after content")
        for (method, params) in baseline.calls {
            if method == .inventory {
                expect(params["currentAccountOnly"] as? Bool == true && params["archived"] as? Bool == false, "inventory stays current-account and nonarchived")
            } else { expect(params["threadId"] as? String == target, "every content read uses requested UUID") }
            if method == .metadata { expect(params["includeTurns"] as? Bool == false, "metadata avoids full-history hydration") }
        }

        let absent = FixtureTransport { _, _ in page([inventory(other)]) }
        failure(.notInInventory, { _ = try CodexConversationReader(transport: absent).snapshot(threadID: target) }, "no other-thread fallback")
        expect(absent.calls.count == 1 && absent.calls[0].0 == .inventory, "unowned thread is never read")
        for hidden in [["ephemeral": true], ["canAcceptDirectInput": false], ["source": "subagent"]] as [[String: Any]] {
            var row = inventory(); hidden.forEach { row[$0] = $1 }
            let fixture = FixtureTransport { _, _ in page([row]) }
            failure(.notInInventory, { _ = try CodexConversationReader(transport: fixture).snapshot(threadID: target) }, "ineligible inventory target rejected")
        }
        let wrong = FixtureTransport { method, _ in method == .inventory ? page([inventory()]) : metadata(other) }
        failure(.wrongThread, { _ = try CodexConversationReader(transport: wrong).snapshot(threadID: target) }, "metadata identity mismatch aborts")
        expect(wrong.calls.count == 2, "identity mismatch never reads turns")
        let wrongTurn = standard([message("Other turn text", turn: "wrong-turn")])
        failure(.wrongThread, { _ = try CodexConversationReader(transport: wrongTurn).snapshot(threadID: target) }, "wrong turn item aborts")

        var inventoryReads = 0
        let switchedAccount = FixtureTransport { method, _ in
            switch method {
            case .inventory: inventoryReads += 1; return page(inventoryReads == 1 ? [inventory()] : [])
            case .metadata: return metadata()
            case .turns: return page([turn()])
            case .items: return page([message("Do not return after account change")])
            }
        }
        failure(.notInInventory, { _ = try CodexConversationReader(transport: switchedAccount).snapshot(threadID: target) }, "account change prevents output")

        let paginated = FixtureTransport { method, params in
            switch method {
            case .inventory: return params["cursor"] == nil ? page([inventory(other)], "inventory-2") : page([inventory()])
            case .metadata: return metadata(state: "notLoaded")
            case .turns: return params["cursor"] == nil ? page([], "turns-2") : page([turn()])
            case .items:
                return params["cursor"] == nil ? page([message("Working", phase: "commentary", id: "progress")], "items-2") : page([message("Finished answer")])
            }
        }
        let paged = try CodexConversationReader(transport: paginated).snapshot(threadID: target)
        expect(paged.reply?.text == "Finished answer" && paged.reply?.phase == "final_answer", "reply pagination prefers final over progress")
        expect(paged.state == "unknown", "notLoaded is never labeled idle or complete")
        expect(!paged.limited, "exhaustive page read is not truncated")
        for method in [CodexReadMethod.inventory, .turns, .items] {
            expect(paginated.calls.contains { $0.0 == method && $0.1["cursor"] != nil }, "all three read page cursors used")
        }
        let repeated = FixtureTransport { _, _ in page([], "same-cursor") }
        failure(.invalidResponse, { _ = try CodexConversationReader(transport: repeated).snapshot(threadID: target) }, "repeated cursor aborts")
        var n = 0
        let excess = FixtureTransport { _, _ in n += 1; return page([], "cursor-\(n)") }
        failure(.paginationLimit, { _ = try CodexConversationReader(transport: excess).snapshot(threadID: target) }, "inventory page budget bounded")
        expect(n == CodexReaderPolicy.inventoryPages, "inventory reads cannot grow unbounded")

        let phases = standard([message("Newest progress", phase: "commentary", id: "c"), message("Final answer", id: "f"), message("Older final", id: "older")])
        let selected = try CodexConversationReader(transport: phases).snapshot(threadID: target)
        expect(selected.reply?.itemId == "f", "latest final selected, not newest progress or older answer")
        let partial = try CodexConversationReader(transport: standard([message("Progress", phase: "commentary", id: "c"), message("Partial", phase: "partial_answer", id: "p")])).snapshot(threadID: target)
        expect(partial.reply?.phase == "partial_answer", "partial label retained when no final")
        let unknown = try CodexConversationReader(transport: standard([message("Legacy reply", phase: nil)])).snapshot(threadID: target)
        expect(unknown.reply?.phase == "unknown", "legacy phase never invented as final")
        let commentary = try CodexConversationReader(transport: standard([message("Progress only", phase: "commentary")])).snapshot(threadID: target)
        expect(commentary.reply?.phase == "commentary", "progress only remains explicitly progress")

        var suppressed = message("Suppressed text")
        var item = suppressed["item"] as! [String: Any]; item["moderation"] = ["moderated": true]; suppressed["item"] = item
        let ignored: [[String: Any]] = [suppressed,
            ["turnId": "turn-a", "item": ["id": "tool", "type": "commandExecution", "aggregatedOutput": "Private tool output"]],
            ["turnId": "turn-a", "item": ["id": "reasoning", "type": "reasoning", "text": "Hidden reasoning"]],
            ["turnId": "turn-a", "item": ["id": "user", "type": "userMessage", "text": "User draft"]]]
        let ignoredResult = try CodexConversationReader(transport: standard(ignored)).snapshot(threadID: target)
        expect(ignoredResult.reply == nil, "tools, user messages, reasoning and moderated text omitted")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ignoredResult)) as! [String: Any]
        expect(encoded["reply"] is NSNull, "no-answer schema has explicit null")
        let longText = String(repeating: "🙂", count: CodexReaderPolicy.maximumTextCharacters + 1)
        let bounded = try CodexConversationReader(transport: standard([message(longText)])).snapshot(threadID: target)
        expect(bounded.reply?.text.count == CodexReaderPolicy.maximumTextCharacters && bounded.reply?.truncated == true, "long Unicode answers bounded without splitting graphemes")
        let controls = try CodexConversationReader(transport: standard([message("hello\u{0} world\nnext")])).snapshot(threadID: target)
        expect(controls.reply?.text == "hello world\nnext", "control bytes removed and lines retained")

        var itemPages = 0
        let limited = FixtureTransport { method, _ in
            switch method {
            case .inventory: return page([inventory()])
            case .metadata: return metadata()
            case .turns: return page([turn()])
            case .items: itemPages += 1; return page([message("Progress", phase: "commentary", id: "p-\(itemPages)")], "i-\(itemPages)")
            }
        }
        let limitedResult = try CodexConversationReader(transport: limited).snapshot(threadID: target)
        expect(limitedResult.limited && limitedResult.reply?.phase == "commentary", "bounded incomplete history is labeled limited")
        expect(itemPages == CodexReaderPolicy.itemPages, "item page limit enforced")
        let emptyLatest = FixtureTransport { method, params in
            switch method {
            case .inventory: return page([inventory()])
            case .metadata: return metadata(state: "active")
            case .turns: return page([turn("new", "inProgress"), turn("old")])
            case .items: return params["turnId"] as? String == "new" ? page([]) : page([message("Prior answer", turn: "old")])
            }
        }
        let prior = try CodexConversationReader(transport: emptyLatest).snapshot(threadID: target)
        expect(prior.state == "active" && prior.reply?.turnId == "old", "prior reply while working remains identified by its own turn")

        let oversized = FixtureTransport { _, _ in page((0...CodexReaderPolicy.inventoryPageSize).map { _ in inventory(other) }) }
        failure(.invalidResponse, { _ = try CodexConversationReader(transport: oversized).snapshot(threadID: target) }, "oversized page rejected")
        var cursors = Set<String>()
        failure(.invalidResponse, { _ = try CodexReaderPolicy.nextCursor(["nextCursor": 7], seen: &cursors) }, "malformed cursor rejected")
        failure(.invalidResponse, { _ = try CodexReaderPolicy.identifier("\n") }, "invalid item identity rejected")
        try expect(try CodexInventoryProtocol.result(["id": true, "result": [:]], id: 1) == nil, "boolean cannot impersonate response ID")
        print("PASS: \(count) read-only Codex reader checks")
    }
}
