import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("an early Claude process exit rejects the query without crashing its host", {
	skip: process.platform === "win32", timeout: 20000,
}, () => {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import { query } from ${JSON.stringify(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))};
		try {
			for await (const message of query({ prompt: "x".repeat(1048576), options: { pathToClaudeCodeExecutable: "/bin/false" } })) {}
			process.exitCode = 2;
		} catch (error) {
			console.log("CONTROLLED_REJECTION:", error.message);
		}
	`], { encoding: "utf8", timeout: 15000, maxBuffer: 256 * 1024 });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /CONTROLLED_REJECTION: Claude Code process exited with code 1/);
	assert.doesNotMatch(result.stderr, /Unhandled 'error' event|Uncaught exception/);
});
