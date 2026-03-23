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
		Type.Union([Type.Literal("check"), Type.Literal("abort"), Type.Literal("list")], {
			description:
				"Action to perform. 'check' (default): get status/result. 'abort': cancel running agent. 'list': list all agents.",
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
			"Check the status of background agents, retrieve their results, or abort running agents. " +
			"Use after spawning agents with run_in_background: true.",
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
