/**
 * A recap is the session's own model asked one more question about its own context.
 * Claude Code caches the request prefix, so the fork is cheap only while it reproduces
 * the turn it forks from: model string, system prompt append, settings and tool
 * definitions all sit inside that prefix. These tests pin the two halves of that —
 * everything is inherited, and only the fork mechanics are overridden — plus the
 * three ways a fork could reach outside the turn it is supposed to be a copy of.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const liveOptions = () => ({
	cwd: "/tmp/fork-cwd",
	env: { DISABLE_AUTO_COMPACT: "1" },
	tools: [],
	permissionMode: "bypassPermissions",
	includePartialMessages: true,
	settings: { claudeMdExcludes: ["**/CLAUDE.md"], includeGitInstructions: false },
	systemPrompt: { type: "preset", preset: "claude_code", append: "pi system prompt" },
	extraArgs: { model: "claude-opus-5[1m]", "strict-mcp-config": null },
	mcpServers: { live: "server bound to a QueryContext" },
	resume: "session-before-the-turn",
});

const piTools = () => [{
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: {} },
	execute: () => { throw new Error("a recap must never reach a tool implementation"); },
}];

function record(overrides = {}) {
	__test.recordRecapForkTemplate({
		options: liveOptions(),
		tools: piTools(),
		modelId: "claude-opus-5",
		sessionId: "session-holding-the-turn",
		...overrides,
	});
	return __test.peekRecapForkTemplate();
}

describe("recap fork options", () => {
	it("resumes the session that holds the completed turn, as a fork", () => {
		const opts = __test.recapForkOptions(record(), "session-holding-the-turn");
		assert.equal(opts.resume, "session-holding-the-turn");
		assert.equal(opts.forkSession, true);
	});

	it("writes no session file, so a recap leaves nothing to clean up", () => {
		assert.equal(__test.recapForkOptions(record(), "s").persistSession, false);
	});

	it("answers in one turn", () => {
		assert.equal(__test.recapForkOptions(record(), "s").maxTurns, 1);
	});

	it("inherits every field that forms the cached prefix", () => {
		const live = liveOptions();
		const opts = __test.recapForkOptions(record(), "s");
		assert.deepEqual(opts.systemPrompt, live.systemPrompt);
		assert.deepEqual(opts.settings, live.settings);
		assert.deepEqual(opts.env, live.env);
		assert.deepEqual(opts.tools, live.tools);
		assert.equal(opts.cwd, live.cwd);
		assert.equal(opts.permissionMode, live.permissionMode);
		assert.equal(opts.extraArgs.model, live.extraArgs.model);
	});

	it("still declares the tools, because their definitions are inside the prefix", () => {
		const opts = __test.recapForkOptions(record(), "s");
		assert.equal(Object.keys(opts.mcpServers).length, 1);
	});

	it("declares no tool server when the turn had no tools", () => {
		assert.equal(__test.refusingMcpServers([]), undefined);
	});
});

describe("a recap fork cannot reach outside the turn it copies", () => {
	// Without strict MCP, Claude Code loads servers from ~/.claude.json and
	// .mcp.json. Those handlers are real, so a recap turn that called one would
	// run it for effect — and maxTurns bounds assistant turns, not tool time.
	it("forces strict MCP even when the turn it copies did not", () => {
		const options = liveOptions();
		delete options.extraArgs["strict-mcp-config"];
		const template = record({ options });
		const opts = __test.recapForkOptions(template, "s");
		assert.equal(opts.strictMcpConfig, true);
		assert.equal("strict-mcp-config" in opts.extraArgs, true);
	});

	it("does not retain the live tool servers, which are bound to a finished turn", () => {
		assert.equal("mcpServers" in record().options, false);
	});

	it("keeps only tool definitions, never anything that could execute one", () => {
		assert.deepEqual(record().tools, [{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: {} },
		}]);
	});

	it("pairs the options with the session the turn was written into", () => {
		assert.equal(record().sessionId, "session-holding-the-turn");
	});
});
