import * as piAi from "@earendil-works/pi-ai";
import type { Context, Tool } from "@earendil-works/pi-ai";

// Pi 0.86 hands providers a normalized transcript: the system prompt and the tool
// declarations travel as `role: "system"` messages (a leading one, then patches),
// and `context.systemPrompt` / `context.tools` are gone. Pi 0.85 still passes them
// as fields. The bridge indexes `messages` positionally in many places, so both
// shapes are folded back into the field form here and nothing downstream sees a
// system message.

/** The pi-ai 0.86 replay helpers the bridge needs. Absent on 0.85. */
export type TranscriptHelpers = {
	normalizeContext(context: ProviderInput): { messages: Context["messages"] };
	getCurrentSystemPrompt(messages: readonly { role: string }[]): string;
	getCurrentTools(messages: readonly { role: string }[]): Tool[];
};

/** A provider input from either host generation. */
export type ProviderInput = {
	messages: Context["messages"];
	systemPrompt?: string;
	tools?: Tool[];
};

let helpers: Partial<TranscriptHelpers> = piAi as unknown as Partial<TranscriptHelpers>;

/** Test seam: substitute the replay helpers, or `null` to restore pi-ai's. */
export function setTranscriptHelpers(next: Partial<TranscriptHelpers> | null): void {
	helpers = next ?? (piAi as unknown as Partial<TranscriptHelpers>);
}

function isSystem(message: { role: string }): boolean {
	return message.role === "system";
}

/**
 * Fold a provider input into the `{ systemPrompt, tools, messages }` shape, with
 * every system message removed from `messages`.
 *
 *   0.85: { systemPrompt: "P", tools: [t], messages: [user] }
 *   0.86: { messages: [{ role: "system", content: "P", toolsAdded: [t] }, user] }
 *   both: { systemPrompt: "P", tools: [t], messages: [user] }
 *
 * Top-level fields and system messages together are read the way pi-ai's own
 * `normalizeContext` reads them: the fields seed a leading system message and
 * the later ones still patch it.
 */
export function readTranscript(input: ProviderInput): Context {
	if (!input.messages.some(isSystem)) {
		return { systemPrompt: input.systemPrompt, tools: input.tools, messages: input.messages };
	}
	const { normalizeContext, getCurrentSystemPrompt, getCurrentTools } = helpers;
	if (typeof normalizeContext !== "function" || typeof getCurrentSystemPrompt !== "function" || typeof getCurrentTools !== "function") {
		throw new Error(
			"claude-bridge: the transcript carries system messages, but this pi-ai exports no "
			+ "normalizeContext/getCurrentSystemPrompt/getCurrentTools to replay them (expected on Pi 0.86 or newer)",
		);
	}
	const messages = normalizeContext(input).messages;
	const systemPrompt = getCurrentSystemPrompt(messages);
	return {
		systemPrompt: systemPrompt.length > 0 ? systemPrompt : undefined,
		tools: getCurrentTools(messages),
		messages: messages.filter((message) => !isSystem(message)),
	};
}
