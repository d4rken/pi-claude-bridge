#!/usr/bin/env node

/**
 * How the provider refuses a prompt it cannot account for.
 *
 * Refusing is deliberate: forwarding an unresolvable prompt would hand Claude
 * Code either nothing or Pi's own harness, and diag/EXTRA-USAGE-400.md ties that
 * harness to an HTTP 400. What matters here is the *transport* of the refusal.
 *
 * Pi normalizes a thrown provider error into a failed assistant message only for
 * callers that own an AgentSession. A low-level `agentLoop` caller — a background
 * worker, an observational-memory observer — calls the provider from a detached
 * promise, where a synchronous throw is an uncaughtException that ends the pi
 * process rather than the turn. So the refusal has to arrive as a terminal event
 * on the returned stream.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/index.js";
import { PI_PREAMBLE } from "../src/prompt-capture.js";

const { streamClaudeAgentSdk, getSharedSession, resetSharedSession } = __test;

const model = { id: "claude-fable-5-1", provider: "claude-bridge", api: "claude-bridge" };

function query(systemPrompt) {
	return streamClaudeAgentSdk(model, {
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		tools: [],
	});
}

async function terminalEvent(stream) {
	for await (const event of stream) {
		if (event.type === "error" || event.type === "done") return event;
	}
	return undefined;
}

describe("refusing an unaccountable system prompt", () => {
	it("returns a stream instead of throwing, so a detached caller survives", () => {
		assert.doesNotThrow(() => query("a prompt no before_agent_start ever recorded"));
	});

	it("ends that stream with a terminal error carrying the reason", async () => {
		const event = await terminalEvent(query("another prompt we never recorded"));

		assert.ok(event, "the stream must terminate, or a detached caller waits forever");
		assert.equal(event.type, "error");
		assert.equal(event.reason, "error");
		assert.equal(event.error.stopReason, "error");
		assert.match(event.error.errorMessage, /no capture for this \d+-char system prompt/);
	});

	it("resolves result() with the same failure, for callers that await it", async () => {
		const stream = query("a prompt awaited rather than iterated");
		const settled = await stream.result();

		assert.equal(settled.stopReason, "error");
		assert.match(settled.errorMessage, /no capture for this \d+-char system prompt/);
	});

	it("leaves the shared Claude Code session untouched", async () => {
		resetSharedSession();
		await terminalEvent(query("a prompt that must not disturb the session"));

		assert.equal(getSharedSession(), null, "a refused turn must not claim or rotate a session");
	});

	it("refuses a recorded prompt carrying pi's harness the same way", async () => {
		const leaking = `${PI_PREAMBLE}, a recorded prompt the harness guard rejects`;
		__test.promptCaptures.record(leaking, { custom: leaking, contextFiles: [], skills: [] }, "before_agent_start");

		let stream;
		assert.doesNotThrow(() => { stream = query(leaking); });
		const event = await terminalEvent(stream);

		assert.equal(event?.type, "error");
		assert.match(event.error.errorMessage, /refusing to send this prompt/);
	});

	it("attributes the failed turn to the model that was asked", async () => {
		const { error } = await terminalEvent(query("yet another unrecorded prompt"));

		assert.equal(error.model, model.id);
		assert.equal(error.provider, model.provider);
		assert.deepEqual(error.content, []);
	});
});
