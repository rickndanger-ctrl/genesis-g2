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
    static func user(_ text: String, turn: String = "turn-a", id: String = "user-a", field: String = "content") -> [String: Any] {
        ["turnId": turn, "item": ["id": id, "type": "userMessage", field: [["type": "text", "text": text, "text_elements": []]]]]
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
        expect(itemPages == CodexReaderPolicy.conversationItemPageLimit, "conversation search obeys hard item page limit and reuses legacy prefix")
        expect(limitedResult.turnsTruncated && limitedResult.turns.allSatisfy { $0.role == "assistant" }, "exhausted search never invents missing user context")
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

        let exchange = standard([message("Actual answer"), user("Actual question")])
        let transcript = try CodexConversationReader(transport: exchange).snapshot(threadID: target)
        expect(transcript.turns.map(\.role) == ["user", "assistant"] && transcript.turns.map(\.text) == ["Actual question", "Actual answer"], "real messages ordered oldest to newest")
        expect(transcript.turns[0].phase == nil && transcript.turns[1].phase == "final_answer", "only assistant carries visible phase")
        expect(!transcript.turnsTruncated && transcript.reply?.text == "Actual answer", "conversation does not alter legacy reply")
        expect(exchange.calls.filter { $0.0 == .items }.count == 1, "new conversation pass reuses existing item page")
        expect(exchange.calls.filter { $0.0 == .turns }.count == 1 && exchange.calls.filter { $0.0 == .inventory }.count == 2, "cache does not skip account recheck")
        let inputShape = try CodexConversationReader(transport: standard([user("Input variant", field: "input")])).snapshot(threadID: target)
        expect(inputShape.turns.first?.text == "Input variant" && inputShape.reply == nil, "input text variant supported without invented assistant")
        let rawShape = try CodexConversationReader(transport: standard([["turnId": "turn-a", "item": ["id": "legacy", "type": "userMessage", "text": "Do not assume arbitrary item text is user input"]]])).snapshot(threadID: target)
        expect(rawShape.turns.isEmpty, "unknown user shape does not leak arbitrary text")
        var multipart = user("Visible question")
        var multipartItem = multipart["item"] as! [String: Any]
        multipartItem["content"] = [
            ["type": "text", "text": "Visible question", "text_elements": [["hidden": "private metadata"]]],
            ["type": "image", "text": "Private image metadata", "url": "file:///private/photo.jpg"],
            ["type": "localImage", "path": "/private/photo.jpg"],
            ["type": "tool", "text": "Tool input"],
            ["type": "text", "role": "developer", "text": "Injected developer text"]
        ] as [[String: Any]]
        multipart["item"] = multipartItem
        let visible = try CodexConversationReader(transport: standard([message("Visible answer"), multipart] + ignored)).snapshot(threadID: target)
        expect(visible.turns.map(\.text) == ["Visible question", "Visible answer"], "tools reasoning image metadata and moderated text never become conversation")
        let privacyJSON = String(data: try JSONEncoder().encode(visible), encoding: .utf8)!
        expect(!privacyJSON.contains("private/photo") && !privacyJSON.contains("private metadata") && !privacyJSON.contains("Hidden reasoning") && !privacyJSON.contains("Suppressed text"), "encoded transcript has no excluded payloads")
        for phase in ["analysis", "reasoning", "hidden"] {
            let privatePhase = try CodexConversationReader(transport: standard([message("Private phase text", phase: phase)])).snapshot(threadID: target)
            expect(privatePhase.reply == nil && privatePhase.turns.isEmpty, "explicit private phase never exposed as unknown assistant phase")
        }
        var hiddenUser = user("Hidden app scaffolding")
        var hiddenItem = hiddenUser["item"] as! [String: Any]; hiddenItem["visibility"] = "hidden"; hiddenUser["item"] = hiddenItem
        let hiddenTranscript = try CodexConversationReader(transport: standard([hiddenUser])).snapshot(threadID: target)
        expect(hiddenTranscript.turns.isEmpty, "explicit hidden user item omitted")
        for (entry, role) in [(user("Do not mislabel user"), "assistant"), (message("Do not mislabel assistant"), "user")] {
            var mismatched = entry, mismatchedItem = entry["item"] as! [String: Any]
            mismatchedItem["role"] = role; mismatched["item"] = mismatchedItem
            let mismatchedSnapshot = try CodexConversationReader(transport: standard([mismatched])).snapshot(threadID: target)
            expect(mismatchedSnapshot.turns.isEmpty && mismatchedSnapshot.reply == nil, "explicit role must match allowed item type")
        }
        let fileWrapper = "# Files mentioned by the user:\nSecret.doc: /private/Secret.doc\nDistinguish instructions from the request.\n## My request:\nSummarize the plan.<image name=\"Secret\" path=\"/private/Secret.doc\">hidden attachment text</image>"
        let realtimeWrapper = "<realtime_delegation><input>Use the terminal view.</input><transcript_delta>Private repeated transcript</transcript_delta></realtime_delegation>"
        let answerWrapper = "<send_user_message_question_reply>[{\"question\":\"Hidden repeated question\",\"answer\":\"Yes, both work\"}]</send_user_message_question_reply>"
        let wrappers = try CodexConversationReader(transport: standard([
            user(answerWrapper, id: "answer"), user(realtimeWrapper, id: "realtime"), user(fileWrapper, id: "files"),
            user("# AGENTS.md instructions\n<INSTRUCTIONS>Private instructions</INSTRUCTIONS>", id: "agents"),
            user("<environment_context>private environment</environment_context>", id: "environment"),
            user("<realtime_delegation><source>transcript_tail_flush</source><input>Do not repeat system handoff</input></realtime_delegation>", id: "tail")
        ])).snapshot(threadID: target)
        expect(wrappers.turns.map(\.text) == ["Summarize the plan.", "Use the terminal view.", "Yes, both work"], "known transport wrappers expose only actual user request or answer")
        let formatted = try CodexConversationReader(transport: standard([user("Keep **my Markdown** and `code`.\nNext line\u{0}")])).snapshot(threadID: target)
        expect(formatted.turns.first?.text == "Keep **my Markdown** and `code`.\nNext line", "user formatting retained while control bytes removed")
        var wrongUser = user("Wrong turn", turn: "wrong")
        failure(.wrongThread, { _ = try CodexConversationReader(transport: standard([wrongUser])).snapshot(threadID: target) }, "user item exact turn identity checked")
        wrongUser["turnId"] = "turn-a"
        var roleItem = wrongUser["item"] as! [String: Any]; roleItem["role"] = "system"; wrongUser["item"] = roleItem
        let wrongRole = try CodexConversationReader(transport: standard([wrongUser])).snapshot(threadID: target)
        expect(wrongRole.turns.isEmpty, "explicit system role never appears as user")
        let ongoing = FixtureTransport { method, params in
            switch method {
            case .inventory: return page([inventory()])
            case .metadata: return metadata(state: "active")
            case .turns: return page([turn("new", "inProgress"), turn("old")])
            case .items: return params["turnId"] as? String == "new" ? page([user("New question", turn: "new", id: "new-user")]) : page([message("Old answer", turn: "old"), user("Old question", turn: "old")])
            }
        }
        let working = try CodexConversationReader(transport: ongoing).snapshot(threadID: target)
        expect(working.turns.map(\.text) == ["Old question", "Old answer", "New question"], "latest unanswered user stays after previous completed exchange")
        expect(working.reply?.turnId == "old" && working.state == "active", "prior final answer does not invent completion of newest turn")
        let progressed = try CodexConversationReader(transport: standard((0..<12).map { message("Progress \($0)", phase: "commentary", id: "p-\($0)") } + [user("Newest human request")])).snapshot(threadID: target)
        expect(progressed.turns.count == 6 && progressed.turns.first?.role == "user" && progressed.turns.last?.text == "Progress 0", "latest human request preserved when commentary dominates")
        expect(progressed.turnsTruncated, "dropped visible history explicitly marked")
        let toolHeavy = FixtureTransport { method, params in
            switch method {
            case .inventory: return page([inventory()])
            case .metadata: return metadata(state: "active")
            case .turns: return page([turn("turn-a", "inProgress")])
            case .items:
                let pageIndex = (params["cursor"] as? String).flatMap(Int.init) ?? 0
                let limit = params["limit"] as! Int
                if pageIndex == 7 { return page([user("Latest actual human request")]) }
                var entries: [[String: Any]] = (0..<limit).map { index in
                    ["turnId": "turn-a", "item": ["id": "tool-\(pageIndex)-\(index)", "type": "commandExecution", "aggregatedOutput": "Private tool output"]]
                }
                if pageIndex == 0 {
                    for index in 0..<6 { entries[index] = message("Newest progress \(index)", phase: "commentary", id: "progress-\(index)") }
                }
                if pageIndex == 6 {
                    entries[0] = user("# AGENTS.md instructions\nDo not display injected setup", id: "scaffolding")
                    entries[1] = message("Hidden analysis", phase: "analysis", id: "hidden-analysis")
                }
                return page(entries, String(pageIndex + 1))
            }
        }
        let deepConversation = try CodexConversationReader(transport: toolHeavy).snapshot(threadID: target)
        expect(deepConversation.turns.count == 6 && deepConversation.turns.first?.text == "Latest actual human request", "latest human survives hundreds of intervening tool items")
        expect(deepConversation.turns.last?.text == "Newest progress 0" && deepConversation.turnsTruncated, "deep search preserves chronological bounded excerpt")
        expect(deepConversation.reply?.text == "Newest progress 0" && deepConversation.limited, "deep conversation search leaves legacy reply semantics unchanged")
        let deepCalls = toolHeavy.calls.filter { $0.0 == .items }.map(\.1)
        expect(deepCalls.count == 8 && deepCalls.prefix(5).allSatisfy { $0["limit"] as? Int == 20 } && deepCalls.suffix(3).allSatisfy { $0["limit"] as? Int == 100 }, "cached small prefix continues with larger bounded descending pages")
        expect(deepCalls.allSatisfy { $0["threadId"] as? String == target && $0["turnId"] as? String == "turn-a" && $0["sortDirection"] as? String == "desc" }, "deep search never changes target or direction")
        expect(toolHeavy.calls.filter { $0.0 == .inventory }.count == 2, "deep search rechecks account before publishing")
        expect(!deepConversation.turns.contains { $0.text.contains("Private") || $0.text.contains("injected") || $0.text.contains("Hidden") }, "deep scan retains privacy filtering beyond normal search window")
        let bigUser = String(repeating: "e\u{301}", count: 9000)
        let bigAssistant = String(repeating: "🙂", count: 9000)
        let bigConversation = try CodexConversationReader(transport: standard([message(bigAssistant), user(bigUser), user("Older question", id: "older-user")])).snapshot(threadID: target)
        expect(bigConversation.turns.count == 2 && bigConversation.turns.map(\.role) == ["user", "assistant"], "budget reserves newest user and assistant")
        expect(bigConversation.turns.reduce(0) { $0 + $1.text.unicodeScalars.count } == 16000, "conversation total is bounded by Unicode scalars")
        expect(bigConversation.turns.allSatisfy { $0.text.unicodeScalars.count <= 8000 && $0.truncated } && bigConversation.turnsTruncated, "per-message scalar clipping is explicit")
        let acrossTurns = FixtureTransport { method, params in
            switch method {
            case .inventory: return page([inventory()])
            case .metadata: return metadata()
            case .turns: return page((0..<5).map { turn("turn-\($0)") })
            case .items:
                let id = params["turnId"] as! String
                return page([message("Answer " + id, turn: id), user("Question " + id, turn: id)])
            }
        }
        let recent = try CodexConversationReader(transport: acrossTurns).snapshot(threadID: target)
        expect(recent.turns.count == 6 && recent.turns.first?.text == "Question turn-2" && recent.turns.last?.text == "Answer turn-0", "latest three exchanges sorted chronologically")
        expect(recent.turnsTruncated && acrossTurns.calls.filter { $0.0 == .items }.count == 3, "older turn traversal stops after bounded recent window")
        print("PASS: \(count) read-only Codex reader checks")
    }
}
