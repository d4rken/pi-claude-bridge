#!/usr/bin/env node

/**
 * Pi 0.86 hands providers a normalized transcript: the system prompt and the tool
 * declarations ride in `role: "system"` messages instead of `context.systemPrompt`
 * and `context.tools`. The bridge indexes `messages` positionally, so both shapes
 * are folded back into the field form before anything else runs.
 *
 * The replay helpers below are pi-ai 0.86.1's (packages/ai/src/utils/transcript.ts
 * and text.ts), copied so the 0.86 shape is exercised on a 0.85 development host.
 * When the installed pi-ai exports them itself, the last case checks that the
 * bridge reaches for those without the seam.
 */

import { describe, it, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as piAi from "@earendil-works/pi-ai";
import activate, { __test } from "../src/index.js";
import { readTranscript, setTranscriptHelpers } from "../src/transcript.js";

function contentText(content) {
	if (typeof content === "string") return content;
	return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function getCurrentTools(messages) {
	const tools = new Map();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

function getCurrentSystemPrompt(messages) {
	const content = [];
	const sections = new Map();
	let seen = false;
	for (const message of messages) {
		if (message.role !== "system") continue;
		seen = true;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	if (!seen && getCurrentTools(messages).length === 0) return "";
	return [content.join("\n\n"), ...sections.values()].filter((part) => part.length > 0).join("\n\n");
}

function normalizeContext(context) {
	const hasPrompt = context.systemPrompt !== undefined && context.systemPrompt.length > 0;
	const hasTools = context.tools !== undefined && context.tools.length > 0;
	if (!hasPrompt && !hasTools) return { messages: context.messages };
	const initial = { role: "system", content: context.systemPrompt ?? "", ...(hasTools ? { toolsAdded: context.tools } : {}), timestamp: 0 };
	return { messages: [initial, ...context.messages] };
}

const helpers = { normalizeContext, getCurrentSystemPrompt, getCurrentTools };
const hostHasHelpers = ["normalizeContext", "getCurrentSystemPrompt", "getCurrentTools"].every((name) => typeof piAi[name] === "function");

const read = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const bash = { name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } };
const edit = { name: "edit", description: "Edit a file", parameters: { type: "object", properties: {} } };

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2 });

describe("readTranscript", () => {
	after(() => setTranscriptHelpers(null));

	it("passes a 0.85 context through with the same message array", () => {
		const messages = [user("hi")];
		const context = { systemPrompt: "P", tools: [read], messages };

		const result = readTranscript(context);

		assert.equal(result.systemPrompt, "P");
		assert.deepEqual(result.tools, [read]);
		assert.equal(result.messages, messages, "no system messages means nothing to strip");
	});

	it("replays a 0.86 transcript into prompt, tools and system-free messages", () => {
		setTranscriptHelpers(helpers);
		const transcript = {
			messages: [
				{ role: "system", content: "Base.", sections: { rules: "Rule one." }, toolsAdded: [read, bash], timestamp: 0 },
				user("first"),
				assistant("done"),
				{ role: "system", content: "", sections: { rules: "Rule two." }, toolsRemoved: [bash], toolsAdded: [edit], timestamp: 3 },
				user("second"),
			],
		};

		const result = readTranscript(transcript);

		assert.equal(result.systemPrompt, "Base.\n\nRule two.");
		assert.deepEqual(result.tools.map((tool) => tool.name), ["read", "edit"]);
		assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant", "user"]);
		assert.equal(result.messages[2], transcript.messages[4], "surviving messages keep their identity");
	});

	it("reads top-level fields together with system messages, as normalizeContext does", () => {
		setTranscriptHelpers(helpers);

		const result = readTranscript({
			systemPrompt: "Base.",
			tools: [read, bash],
			messages: [{ role: "system", content: "", sections: { rules: "Rule." }, toolsRemoved: [bash], timestamp: 1 }, user("hi")],
		});

		assert.equal(result.systemPrompt, "Base.\n\nRule.");
		assert.deepEqual(result.tools.map((tool) => tool.name), ["read"]);
		assert.deepEqual(result.messages.map((message) => message.role), ["user"]);
	});

	it("drops a section that a later system message sets to null", () => {
		setTranscriptHelpers(helpers);

		const result = readTranscript({
			messages: [
				{ role: "system", content: "Base.", sections: { rules: "Rule.", skills: "Skill." }, timestamp: 0 },
				user("first"),
				{ role: "system", content: "", sections: { rules: null }, timestamp: 2 },
				user("second"),
			],
		});

		assert.equal(result.systemPrompt, "Base.\n\nSkill.");
	});

	it("reports no prompt when the system messages only declare tools", () => {
		setTranscriptHelpers(helpers);

		const result = readTranscript({ messages: [{ role: "system", content: "", toolsAdded: [read], timestamp: 0 }, user("hi")] });

		assert.equal(result.systemPrompt, undefined);
		assert.deepEqual(result.tools, [read]);
	});

	it("names the missing host helpers instead of silently dropping the prompt", { skip: hostHasHelpers }, () => {
		setTranscriptHelpers(null);

		assert.throws(
			() => readTranscript({ messages: [{ role: "system", content: "P", timestamp: 0 }, user("hi")] }),
			/normalizeContext\/getCurrentSystemPrompt\/getCurrentTools/,
		);
	});

	it("uses the installed pi-ai helpers when the host exports them", { skip: !hostHasHelpers }, () => {
		setTranscriptHelpers(null);

		const result = readTranscript({
			messages: [{ role: "system", content: "P", toolsAdded: [read], timestamp: 0 }, user("hi")],
		});

		assert.equal(result.systemPrompt, "P");
		assert.deepEqual(result.tools.map((tool) => tool.name), ["read"]);
		assert.deepEqual(result.messages.map((message) => message.role), ["user"]);
	});
});

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
		setTranscriptHelpers(helpers);
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

		// A host that cannot replay the transcript fails the turn on the stream, so a
		// detached low-level caller sees a failed turn rather than an uncaught throw.
		if (!hostHasHelpers) {
			setTranscriptHelpers(null);
			const unsupported = provider.streamSimple(model, { messages: [head, user("Continue.")] }, { cwd: root, signal: new AbortController().signal });
			const settled = await unsupported.result();
			assert.equal(settled.stopReason, "error");
			assert.match(settled.errorMessage, /normalizeContext\/getCurrentSystemPrompt\/getCurrentTools/);
		}
	} finally {
		process.chdir(savedCwd);
		for (const stream of streams) await stream.result();
		handlers.get("session_shutdown")?.();
		__test.resetSharedSession();
		setTranscriptHelpers(null);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
