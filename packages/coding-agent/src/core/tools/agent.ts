import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type StreamFn,
} from "@dg-forsonny/dg-pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@dg-forsonny/dg-pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentDefinition } from "../agents.js";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// ============================================================================
// Schema
// ============================================================================

const agentSchema = Type.Object({
	agent: Type.String({ description: "Name of the agent type to spawn (from available_agents list)" }),
	task: Type.String({ description: "Detailed task description / prompt for the agent" }),
	context: Type.Optional(
		Type.String({ description: "Optional additional context to include (file contents, prior findings, etc.)" }),
	),
});

export type AgentToolInput = Static<typeof agentSchema>;

export interface AgentToolDetails {
	agentName: string;
	turns: number;
	totalTokens: number;
	cost: number;
}

// ============================================================================
// Options
// ============================================================================

export interface AgentToolOptions {
	/** Working directory */
	cwd: string;
	/** Registry of available agent definitions */
	agentRegistry: Map<string, AgentDefinition>;
	/** Parent's tool definitions (for tool inheritance) */
	parentToolDefinitions: Map<string, ToolDefinition>;
	/** Stream function inherited from parent */
	streamFn: StreamFn;
	/** API key resolver inherited from parent */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Parent's current model (used as default for agents without model override) */
	model: Model<any>;
	/** Current nesting depth (0 = top-level). Default: 0 */
	currentDepth?: number;
	/** Hard nesting limit. Default: 3 */
	maxDepth?: number;
}

// ============================================================================
// System prompt wrapper
// ============================================================================

function buildAgentSystemPrompt(agent: AgentDefinition, cwd: string): string {
	const date = new Date().toISOString().slice(0, 10);
	const promptCwd = cwd.replace(/\\/g, "/");

	const parts: string[] = [];
	parts.push(`You are a specialized agent: ${agent.name}`);
	parts.push(`${agent.description}\n`);

	if (agent.systemPrompt) {
		parts.push(agent.systemPrompt);
		parts.push("");
	}

	parts.push("## Output Guidelines");
	parts.push("- Provide your findings or results clearly and concisely");
	parts.push("- When done, state your conclusion or final result");
	parts.push("- Do not ask follow-up questions -- complete the task with the information available");
	parts.push("");
	parts.push(`Current date: ${date}`);
	parts.push(`Current working directory: ${promptCwd}`);

	return parts.join("\n");
}

// ============================================================================
// Token aggregation
// ============================================================================

function aggregateUsage(messages: AgentMessage[]): { totalTokens: number; cost: number } {
	let totalTokens = 0;
	let cost = 0;

	for (const msg of messages) {
		if (msg.role === "assistant" && "usage" in msg) {
			const usage = (msg as AssistantMessage).usage;
			if (usage) {
				totalTokens += usage.totalTokens;
				cost += usage.cost?.total ?? 0;
			}
		}
	}

	return { totalTokens, cost };
}

function extractFinalText(messages: AgentMessage[]): string {
	// Walk backwards to find the last assistant message with text content
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && "content" in msg) {
			const textBlocks = ((msg as AssistantMessage).content ?? []).filter(
				(c): c is TextContent => c.type === "text" && c.text.trim().length > 0,
			);
			if (textBlocks.length > 0) {
				return textBlocks.map((t) => t.text).join("\n");
			}
		}
	}
	return "(Agent produced no text output)";
}

// ============================================================================
// Tool definition factory
// ============================================================================

export function createAgentToolDefinition(
	options: AgentToolOptions,
): ToolDefinition<typeof agentSchema, AgentToolDetails> {
	const {
		cwd,
		agentRegistry,
		parentToolDefinitions,
		streamFn,
		getApiKey,
		model,
		currentDepth = 0,
		maxDepth = 3,
	} = options;

	return {
		name: "agent",
		label: "Agent",
		description:
			"Spawn an autonomous subagent to handle a focused task independently. " +
			"The agent runs with its own conversation context and returns results when done. " +
			"Use agents for tasks that benefit from focused, independent work -- such as " +
			"codebase exploration, planning, research, writing, or code implementation. " +
			"Prefer doing simple tasks yourself rather than spawning an agent.",
		promptSnippet: "Spawn autonomous subagents for parallel or specialized work",
		promptGuidelines: [
			"Use the agent tool when a task is well-scoped and benefits from focused, independent work",
			"Prefer doing simple, quick tasks yourself rather than spawning an agent",
			"Provide detailed task descriptions so the agent has full context",
			"Check <available_agents> in the system prompt for the list of agent types",
		],
		parameters: agentSchema,

		async execute(_toolCallId, params, _signal) {
			const { agent: agentName, task, context: additionalContext } = params;

			// Validate agent exists
			const agentDef = agentRegistry.get(agentName);
			if (!agentDef) {
				const available = Array.from(agentRegistry.keys()).join(", ");
				return {
					content: [
						{
							type: "text",
							text: `Error: Unknown agent "${agentName}". Available agents: ${available || "(none)"}`,
						},
					],
					details: { agentName, turns: 0, totalTokens: 0, cost: 0 },
				};
			}

			// Check nesting depth
			if (currentDepth >= maxDepth) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Maximum agent nesting depth (${maxDepth}) reached. Cannot spawn more subagents.`,
						},
					],
					details: { agentName, turns: 0, totalTokens: 0, cost: 0 },
				};
			}

			// Resolve tools for the subagent
			const subagentTools: AgentTool[] = [];
			if (agentDef.tools && agentDef.tools.length > 0) {
				// Use only the tools in the agent's allowlist that exist in the parent
				for (const toolName of agentDef.tools) {
					const toolDef = parentToolDefinitions.get(toolName);
					if (toolDef) {
						subagentTools.push(wrapToolDefinition(toolDef));
					}
				}
			} else {
				// Inherit all parent tools except the agent tool itself
				for (const [name, toolDef] of parentToolDefinitions) {
					if (name !== "agent") {
						subagentTools.push(wrapToolDefinition(toolDef));
					}
				}
			}

			// If this agent allows nesting and we haven't hit the depth limit,
			// add a nested agent tool to the subagent's tool set
			if (agentDef.maxNesting > 0 && currentDepth + 1 < maxDepth) {
				const nestedAgentToolDef = createAgentToolDefinition({
					cwd,
					agentRegistry,
					parentToolDefinitions,
					streamFn,
					getApiKey,
					model,
					currentDepth: currentDepth + 1,
					maxDepth,
				});
				subagentTools.push(wrapToolDefinition(nestedAgentToolDef));
			}

			// Build system prompt
			const systemPrompt = buildAgentSystemPrompt(agentDef, cwd);

			// Build the full prompt for the agent
			let fullTask = task;
			if (additionalContext) {
				fullTask += `\n\n## Additional Context\n${additionalContext}`;
			}

			// Create and run the subagent
			const subagent = new Agent({
				initialState: {
					systemPrompt,
					model,
					thinkingLevel: "off",
					tools: subagentTools,
					messages: [],
				},
				streamFn,
				getApiKey,
				toolExecution: "parallel",
			});

			// Track turns
			let turns = 0;
			subagent.subscribe((event: AgentEvent) => {
				if (event.type === "turn_end") {
					turns++;
				}
			});

			try {
				// Run the agent with the task
				await subagent.prompt(fullTask);

				// Wait for completion
				await subagent.waitForIdle();

				// Enforce max turns by checking if we exceeded (the agent loop itself doesn't limit turns,
				// but we can report it)
				const messages = subagent.state.messages;
				const finalText = extractFinalText(messages);
				const usage = aggregateUsage(messages);

				const header = `[Agent: ${agentName} | ${turns} turns | ${usage.totalTokens} tokens]`;

				return {
					content: [
						{
							type: "text",
							text: `${header}\n\n${finalText}`,
						},
					],
					details: {
						agentName,
						turns,
						totalTokens: usage.totalTokens,
						cost: usage.cost,
					},
				};
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `[Agent: ${agentName} | ERROR]\n\n${errorMsg}`,
						},
					],
					details: { agentName, turns, totalTokens: 0, cost: 0 },
				};
			}
		},
	};
}

// ============================================================================
// Convenience exports
// ============================================================================

export function createAgentTool(options: AgentToolOptions): AgentTool<typeof agentSchema, AgentToolDetails> {
	return wrapToolDefinition(createAgentToolDefinition(options));
}
