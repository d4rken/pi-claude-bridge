import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import activate, { __test } from "../src/index.js";

test("abort rotates the next session before the SDK consumer unwinds", {
	skip: process.platform === "win32", timeout: 15000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-abort-"));
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
	let stream;
	try {
		process.chdir(root);
		activate({ on: (name, handler) => handlers.set(name, handler), registerProvider: (_id, config) => { provider = config; } });
		handlers.get("before_agent_start")({ systemPrompt: "Review files.", systemPromptOptions: { customPrompt: "Review files." } });
		const model = { ...provider.models[0], provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge" };
		const sessionId = randomUUID();
		__test.setSharedSession({ sessionId, cursor: 0, cwd: root });
		const abort = new AbortController();
		stream = provider.streamSimple(model, {
			systemPrompt: "Review files.", tools: [],
			messages: [{ role: "user", content: "Continue.", timestamp: Date.now() }],
		}, { signal: abort.signal, cwd: root });
		abort.abort();
		// No await: the next provider call can run before the consumer settles.
		assert.equal(__test.getSharedSession()?.forceRotate, true);
		const next = __test.syncSharedSession([
			{ role: "user", content: "Remember context.", timestamp: Date.now() },
			{ role: "assistant", content: [{ type: "text", text: "Remembered." }], timestamp: Date.now() },
			{ role: "user", content: "Continue after abort.", timestamp: Date.now() },
		], root);
		assert.notEqual(next.sessionId, sessionId, "must not reuse the aborted writer's session file");
		await stream.result();
		assert.equal(__test.getSharedSession()?.sessionId, next.sessionId, "late abort cleanup must not replace the resumed session");
		assert.equal(__test.getSharedSession()?.forceRotate, undefined);
		} finally {
		process.chdir(savedCwd);
		if (stream) await stream.result();
		handlers.get("session_shutdown")?.();
		__test.resetSharedSession();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("abort leaves the shared session alone when the query did not resume it", {
	skip: process.platform === "win32", timeout: 15000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-abort-preserve-"));
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
	let stream;
	try {
		process.chdir(root);
		activate({ on: (name, handler) => handlers.set(name, handler), registerProvider: (_id, config) => { provider = config; } });
		handlers.get("before_agent_start")({ systemPrompt: "Review files.", systemPromptOptions: { customPrompt: "Review files." } });
		const model = { ...provider.models[0], provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge" };
		const sessionId = randomUUID();
		// A context shorter than the parent's cursor is a reentrant query: it starts a
		// session of its own and must not cost the parent its session.
		__test.setSharedSession({ sessionId, cursor: 10, cwd: root });
		const abort = new AbortController();
		stream = provider.streamSimple(model, {
			systemPrompt: "Review files.", tools: [],
			messages: [{ role: "user", content: "Subagent task.", timestamp: Date.now() }],
		}, { signal: abort.signal });
		abort.abort();
		await stream.result();
		assert.equal(__test.getSharedSession()?.sessionId, sessionId);
		assert.equal(__test.getSharedSession()?.forceRotate, undefined);
		assert.equal(__test.getSharedSession()?.needsRebuild, undefined);
	} finally {
		process.chdir(savedCwd);
		if (stream) await stream.result();
		handlers.get("session_shutdown")?.();
		__test.resetSharedSession();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
