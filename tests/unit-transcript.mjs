#!/usr/bin/env node

/**
 * Pi hands providers a transcript: the system prompt and the tool declarations
 * ride in `role: "system"` messages instead of `context.systemPrompt` and
 * `context.tools`. These cases drive that shape through the provider's own entry
 * points; toBridgeContext's replay rules are pinned in
 * unit-transcript-replay-order.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate, { __test } from "../src/index.js";

const read = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2 });

/** The refusal reaches a caller either as a synchronous throw or as the stream's failure. */
async function refusalMessage(run) {
	let stream;
	try {
		stream = run();
	} catch (error) {
		return error.message;
	}
	const settled = await stream.result();
	return settled.stopReason === "error" ? settled.errorMessage : "";
}

test("the provider resolves the 0.86 transcript's prompt and positions", {
	skip: process.platform === "win32", timeout: 15000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-transcript-"));
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
	const savedCwd = process.cwd();
	process.env.PI_CODING_AGENT_DIR = join(root, "pi");
	process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
	mkdirSync(process.env.PI_CODING_AGENT_DIR);
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json"), JSON.stringify({
		startupNoticeShown: "2026-09-18",
		askClaude: { enabled: false },
		provider: { pathToClaudeCodeExecutable: "/bin/false" },
	}));
	const handlers = new Map();
	let provider;
	const streams = [];
	try {
		process.chdir(root);
		activate({ on: (name, handler) => handlers.set(name, handler), registerProvider: (_id, config) => { provider = config; } });
		handlers.get("before_agent_start")({ systemPrompt: "Review files.", systemPromptOptions: { customPrompt: "Review files." } });
		const model = { ...provider.models[0], provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge" };
		const head = { role: "system", content: "Review files.", toolsAdded: [read], timestamp: 0 };

		// The prompt lives in the head system message, so a recorded one is accepted...
		__test.resetSharedSession();
		const accepted = provider.streamSimple(model, {
			messages: [head, user("Remember context."), assistant("Remembered."), user("Continue.")],
		}, { cwd: root, signal: new AbortController().signal });
		streams.push(accepted);
		const session = __test.getSharedSession();
		assert.ok(session, "a recorded prompt starts a Claude Code session");
		assert.equal(session.cursor, 2, "the cursor counts Pi's messages without the system message");

		// ...and an unrecorded one is refused with the capture diagnostic, not forwarded.
		const message = await refusalMessage(() => provider.streamSimple(model, {
			messages: [{ ...head, content: "A prompt nobody recorded." }, user("Continue.")],
		}, { cwd: root, signal: new AbortController().signal }));
		assert.match(message, /no capture for this \d+-char system prompt/);

		// Compaction hands the isolated summary a normalized transcript too: its one
		// system message must not trip the "exactly 1 user message" guard.
		const summary = await __test.isolatedStreamFn(model, {
			messages: [{ role: "system", content: "Summarize.", timestamp: 0 }, user("Summarize this conversation.")],
		}, { cwd: root, signal: new AbortController().signal }).result();
		assert.equal(summary.stopReason, "error", "/bin/false stands in for Claude Code");
		assert.doesNotMatch(summary.errorMessage, /expected exactly 1 user message/);

		// A transcript that cannot be folded fails the turn on the stream, so a
		// detached low-level caller sees a failed turn rather than an uncaught throw.
		const malformed = { role: "system", content: 42, timestamp: 0 };
		let unfoldable;
		assert.doesNotThrow(() => {
			unfoldable = provider.streamSimple(model, { messages: [malformed, user("Continue.")] }, { cwd: root, signal: new AbortController().signal });
		});
		const settled = await unfoldable.result();
		assert.equal(settled.stopReason, "error");

		// The isolated summary folds inside its own failure handling too: the stream
		// ends with the error instead of the detached promise rejecting.
		const unfoldableSummary = await __test.isolatedStreamFn(model, {
			messages: [malformed, user("Summarize this conversation.")],
		}, { cwd: root, signal: new AbortController().signal }).result();
		assert.equal(unfoldableSummary.stopReason, "error");
	} finally {
		process.chdir(savedCwd);
		for (const stream of streams) await stream.result();
		handlers.get("session_shutdown")?.();
		__test.resetSharedSession();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
