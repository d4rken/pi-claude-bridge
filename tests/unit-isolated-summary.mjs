/**
 * Compaction and branch summaries run in their own Claude Code subprocess, isolated from
 * everything pi already owns. Filesystem settings are the one thing that isolation must not
 * cover: they carry the credentials. Cutting them (settingSources: []) authenticated the
 * child against ~/.claude/.credentials.json instead of the configured gateway or cloud
 * provider, so every compaction failed with a 401 while ordinary turns kept working.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

const options = () => __test.isolatedSummaryOptions({
	cwd: "/tmp/summary-cwd",
	systemPrompt: "summarize this",
	cliModel: "claude-haiku-4-5",
});

describe("isolated summary subprocess", () => {
	it("loads the settings sources that carry apiKeyHelper and env", () => {
		assert.deepEqual(options().settingSources, ["user", "project", "local"]);
	});

	it("excludes CLAUDE.md, which those same sources would otherwise pull in", () => {
		assert.deepEqual(options().settings.claudeMdExcludes, ["**/CLAUDE.md", "**/.claude/rules/**"]);
	});

	it("keeps the rest of the isolation", () => {
		const opts = options();
		assert.deepEqual(opts.tools, []);
		assert.deepEqual(opts.skills, []);
		assert.equal(opts.persistSession, false);
		assert.equal(opts.strictMcpConfig, true);
		assert.equal(opts.settings.autoMemoryEnabled, false);
		assert.equal(opts.maxTurns, 1);
	});

	it("passes the Claude launcher override only when one is configured", () => {
		assert.equal("pathToClaudeCodeExecutable" in options(), false);
		assert.equal(
			__test.isolatedSummaryOptions({
				cwd: "/tmp/summary-cwd",
				systemPrompt: "summarize this",
				cliModel: "claude-haiku-4-5",
				claudeExecutable: "/opt/claude",
			}).pathToClaudeCodeExecutable,
			"/opt/claude",
		);
	});
});
