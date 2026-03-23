import type { TextContent } from "@dg-forsonny/dg-pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import type { AgentTracker } from "./agent-tracker.js";

// ============================================================================
// Schema
// ============================================================================

const agentStatusSchema = Type.Object({
	agent_id: Type.Optional(
		Type.String({ description: "ID of a specific background agent to check (e.g. 'agent-1'). Omit to list all." }),
	),
	action: Type.Optional(
		Type.Union([Type.Literal("check"), Type.Literal("abort"), Type.Literal("list"), Type.Literal("send_message")], {
			description:
				"Action to perform. 'check' (default): get status/result. 'abort': cancel running agent. 'list': list all agents. 'send_message': send a follow-up message to an agent.",
		}),
	),
	message: Type.Optional(
		Type.String({
			description:
				"Message to send when action is 'send_message'. The agent resumes with its full context preserved.",
		}),
	),
});

export type AgentStatusInput = Static<typeof agentStatusSchema>;

export interface AgentStatusDetails {
	agentCount: number;
}

// ============================================================================
// Options
// ============================================================================

export interface AgentStatusToolOptions {
	agentTracker: AgentTracker;
}

// ============================================================================
// Formatting
// ============================================================================

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// Tool definition factory
// ============================================================================

export function createAgentStatusToolDefinition(
	options: AgentStatusToolOptions,
): ToolDefinition<typeof agentStatusSchema, AgentStatusDetails> {
	const { agentTracker } = options;

	return {
		name: "agent_status",
		label: "Agent Status",
		description:
			"Check the status of background agents, retrieve their results, abort running agents, or send follow-up messages. " +
			"Use after spawning agents with run_in_background: true. " +
			"Use 'send_message' to continue a completed agent's conversation with its full context preserved.",
		promptSnippet: "Check status of background agents",
		parameters: agentStatusSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const action = params.action ?? "check";
			const agentId = params.agent_id;

			if (action === "list" || (!agentId && action === "check")) {
				// List all tracked agents
				const all = agentTracker.getAll();
				if (all.length === 0) {
					return {
						content: [{ type: "text", text: "No background agents tracked." }],
						details: { agentCount: 0 },
					};
				}

				const lines = all.map((t) => {
					const elapsed = t.endedAt
						? formatDuration(t.endedAt - t.startedAt)
						: formatDuration(Date.now() - t.startedAt);
					const desc = t.description ? ` -- ${t.description}` : "";
					return `- ${t.id}: ${t.agentName} [${t.status}] ${elapsed}${desc}`;
				});

				return {
					content: [{ type: "text", text: `Background agents (${all.length}):\n${lines.join("\n")}` }],
					details: { agentCount: all.length },
				};
			}

			if (!agentId) {
				return {
					content: [{ type: "text", text: "Error: agent_id is required for 'check' and 'abort' actions." }],
					details: { agentCount: 0 },
				};
			}

			const tracked = agentTracker.get(agentId);
			if (!tracked) {
				return {
					content: [{ type: "text", text: `Error: No agent found with ID "${agentId}".` }],
					details: { agentCount: 0 },
				};
			}

			if (action === "abort") {
				if (tracked.status === "running") {
					tracked.agent.abort();
					// Wait briefly for the abort to take effect
					await tracked.promise.catch(() => {});
					return {
						content: [{ type: "text", text: `Agent ${agentId} (${tracked.agentName}) aborted.` }],
						details: { agentCount: 1 },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Agent ${agentId} (${tracked.agentName}) is not running (status: ${tracked.status}).`,
						},
					],
					details: { agentCount: 1 },
				};
			}

			if (action === "send_message") {
				if (!params.message) {
					return {
						content: [{ type: "text", text: "Error: 'message' is required for send_message action." }],
						details: { agentCount: 0 },
					};
				}

				if (tracked.status === "running") {
					// Steer the running agent
					tracked.agent.steer({
						role: "user",
						content: params.message,
						timestamp: Date.now(),
					});
					return {
						content: [
							{
								type: "text",
								text: `Message queued for running agent ${agentId} (${tracked.agentName}). It will be delivered after the current turn.`,
							},
						],
						details: { agentCount: 1 },
					};
				}

				// Agent is completed/idle -- resume with new prompt
				const agent = agentTracker.getAgent(agentId);
				if (!agent) {
					return {
						content: [{ type: "text", text: `Error: Agent instance for ${agentId} is no longer available.` }],
						details: { agentCount: 0 },
					};
				}

				// Mark as running again
				tracked.status = "running";
				tracked.endedAt = undefined;

				try {
					await agent.prompt(params.message);
					await agent.waitForIdle();

					// Extract the new response (last assistant message)
					const messages = agent.state.messages;
					let responseText = "(No response)";
					for (let i = messages.length - 1; i >= 0; i--) {
						const msg = messages[i];
						if (msg.role === "assistant" && "content" in msg) {
							const textBlocks = ((msg as any).content ?? []).filter(
								(c: any) => c.type === "text" && c.text?.trim(),
							);
							if (textBlocks.length > 0) {
								responseText = textBlocks.map((t: any) => t.text).join("\n");
								break;
							}
						}
					}

					tracked.status = "success";
					tracked.endedAt = Date.now();

					const elapsed = formatDuration(tracked.endedAt - tracked.startedAt);
					return {
						content: [
							{
								type: "text",
								text: `[Agent ${agentId}: ${tracked.agentName} | resumed | ${elapsed}]\n\n${responseText}`,
							},
						],
						details: { agentCount: 1 },
					};
				} catch (error) {
					tracked.status = "error";
					tracked.endedAt = Date.now();
					const errorMsg = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Error resuming agent ${agentId}: ${errorMsg}` }],
						details: { agentCount: 1 },
					};
				}
			}

			// action === "check"
			if (tracked.status === "running") {
				const elapsed = formatDuration(Date.now() - tracked.startedAt);
				return {
					content: [
						{
							type: "text",
							text: `Agent ${agentId} (${tracked.agentName}) is still running (${elapsed}).`,
						},
					],
					details: { agentCount: 1 },
				};
			}

			// Agent completed -- return full result
			if (tracked.result) {
				const elapsed = tracked.endedAt ? formatDuration(tracked.endedAt - tracked.startedAt) : "";
				const header = `[Agent ${agentId}: ${tracked.agentName} | ${tracked.status} | ${elapsed}]`;
				const textContent = tracked.result.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				return {
					content: [{ type: "text", text: `${header}\n\n${textContent}` }],
					details: { agentCount: 1 },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Agent ${agentId} (${tracked.agentName}) completed with status: ${tracked.status} (no result available).`,
					},
				],
				details: { agentCount: 1 },
			};
		},
	};
}
