/**
 * A recap is the session's own model asked one more question about its own context.
 * Claude Code caches the request prefix, so the fork is cheap only while it reproduces
 * the turn it forks from: model string, system prompt append, settings and tool
 * definitions all sit inside that prefix. These tests pin the two halves of that —
 * everything is inherited, and only the fork mechanics are overridden.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const template = () => ({
	options: {
		cwd: "/tmp/fork-cwd",
		env: { DISABLE_AUTO_COMPACT: "1" },
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		settings: { claudeMdExcludes: ["**/CLAUDE.md"], includeGitInstructions: false },
		systemPrompt: { type: "preset", preset: "claude_code", append: "pi system prompt" },
		extraArgs: { model: "claude-opus-5[1m]" },
		mcpServers: { live: "server that executes pi tools" },
		resume: "session-before-the-turn",
	},
	tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
	modelId: "claude-opus-5",
});

describe("recap fork options", () => {
	it("resumes the session that holds the completed turn, as a fork", () => {
		const opts = __test.recapForkOptions(template(), "session-after-the-turn");
		assert.equal(opts.resume, "session-after-the-turn");
		assert.equal(opts.forkSession, true);
	});

	it("writes no session file, so a recap leaves nothing to clean up", () => {
		assert.equal(__test.recapForkOptions(template(), "s").persistSession, false);
	});

	it("answers in one turn", () => {
		assert.equal(__test.recapForkOptions(template(), "s").maxTurns, 1);
	});

	it("inherits every field that forms the cached prefix", () => {
		const source = template();
		const opts = __test.recapForkOptions(source, "s");
		assert.deepEqual(opts.systemPrompt, source.options.systemPrompt);
		assert.deepEqual(opts.settings, source.options.settings);
		assert.deepEqual(opts.extraArgs, source.options.extraArgs);
		assert.deepEqual(opts.env, source.options.env);
		assert.deepEqual(opts.tools, source.options.tools);
		assert.equal(opts.cwd, source.options.cwd);
		assert.equal(opts.permissionMode, source.options.permissionMode);
	});

	it("does not reuse the live tool servers, which would execute pi's tools", () => {
		const opts = __test.recapForkOptions(template(), "s");
		assert.notDeepEqual(opts.mcpServers, template().options.mcpServers);
	});

	it("still declares the tools, because their definitions are inside the prefix", () => {
		const opts = __test.recapForkOptions(template(), "s");
		assert.equal(typeof opts.mcpServers, "object");
		assert.equal(Object.keys(opts.mcpServers).length, 1);
	});

	it("declares no tool server when the turn had no tools", () => {
		const source = { ...template(), tools: [] };
		assert.equal(__test.refusingMcpServers(source.tools), undefined);
	});
});
