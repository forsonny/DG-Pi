import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentToolResult,
	type StreamFn,
	type ThinkingLevel,
} from "@dg-forsonny/dg-pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@dg-forsonny/dg-pi-ai";
import { getModel } from "@dg-forsonny/dg-pi-ai";
import { Text } from "@dg-forsonny/dg-pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import type { AgentDefinition } from "../agents.js";
import type { ToolDefinition } from "../extensions/types.js";
import type { AgentTracker } from "./agent-tracker.js";
import { createAllToolDefinitions } from "./index.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { createWorktree, hasChanges, isGitRepo, removeWorktree, type WorktreeInfo } from "./worktree.js";

// ============================================================================
// Schema
// ============================================================================

const agentSchema = Type.Object({
	agent: Type.String({ description: "Name of the agent type to spawn (from available_agents list)" }),
	task: Type.String({ description: "Detailed task description / prompt for the agent" }),
	description: Type.Optional(Type.String({ description: "Short (3-5 word) summary of what the agent will do" })),
	context: Type.Optional(
		Type.String({ description: "Optional additional context to include (file contents, prior findings, etc.)" }),
	),
	model: Type.Optional(
		Type.String({ description: "Optional model override for this agent (e.g. 'anthropic/claude-sonnet-4')" }),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"When true, the agent runs asynchronously and returns immediately with an agent ID. Use agent_status to check results later.",
		}),
	),
	isolation: Type.Optional(
		Type.Union([Type.Literal("worktree")], {
			description:
				'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.',
		}),
	),
	maxCost: Type.Optional(
		Type.Number({
			description: "Maximum cost in dollars for this agent invocation. Overrides agent and global defaults.",
		}),
	),
});

export type AgentToolInput = Static<typeof agentSchema>;

export interface AgentToolDetails {
	agentName: string;
	description?: string;
	turns: number;
	totalTokens: number;
	cost: number;
	status: "success" | "error" | "aborted" | "max-turns" | "cost-limit";
	durationMs: number;
	worktree?: {
		path: string;
		branch: string;
		hasChanges: boolean;
	};
}

// ============================================================================
// Render state
// ============================================================================

type AgentRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	turns: number;
	status: string;
	interval: NodeJS.Timeout | undefined;
};

// ============================================================================
// Options
// ============================================================================

export interface AgentToolOptions {
	/** Working directory */
	cwd: string;
	/** Registry of available agent definitions */
	agentRegistry: Map<string, AgentDefinition>;
	/** Parent's FULL tool definitions (base + extension + custom) */
	parentToolDefinitions: Map<string, ToolDefinition>;
	/** Stream function inherited from parent */
	streamFn: StreamFn;
	/** API key resolver inherited from parent */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Parent's current model (used as default for agents without model override) */
	model: Model<any>;
	/** Project context files (AGENTS.md, CLAUDE.md) to pass to subagents */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Default max cost in dollars for agent invocations (from settings) */
	defaultMaxCost?: number;
	/** Tracker for background agent execution */
	agentTracker?: AgentTracker;
	/** Current nesting depth (0 = top-level). Default: 0 */
	currentDepth?: number;
	/** Hard nesting limit. Default: 3 */
	maxDepth?: number;
}

// ============================================================================
// System prompt wrapper
// ============================================================================

function buildAgentSystemPrompt(
	agent: AgentDefinition,
	cwd: string,
	contextFiles?: Array<{ path: string; content: string }>,
): string {
	const date = new Date().toISOString().slice(0, 10);
	const promptCwd = cwd.replace(/\\/g, "/");

	const parts: string[] = [];
	parts.push(`You are a specialized agent: ${agent.name}`);
	parts.push(`${agent.description}\n`);

	if (agent.systemPrompt) {
		parts.push(agent.systemPrompt);
		parts.push("");
	}

	// Include project context files (AGENTS.md, CLAUDE.md)
	if (contextFiles && contextFiles.length > 0) {
		parts.push("## Project Context\n");
		parts.push("Project-specific instructions and guidelines:\n");
		for (const { path: filePath, content } of contextFiles) {
			parts.push(`### ${filePath}\n\n${content}\n`);
		}
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
// Model resolution
// ============================================================================

function resolveModel(modelSpec: string | undefined, fallback: Model<any>): Model<any> {
	if (!modelSpec) return fallback;

	// Format: "provider/model-id"
	const slashIndex = modelSpec.indexOf("/");
	if (slashIndex === -1) return fallback;

	const provider = modelSpec.slice(0, slashIndex);
	const modelId = modelSpec.slice(slashIndex + 1);

	try {
		const resolved = getModel(provider as any, modelId as any);
		if (resolved) return resolved;
	} catch {
		// Fall through to default
	}
	return fallback;
}

function resolveThinkingLevel(level: string | undefined): ThinkingLevel {
	const valid: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
	if (level && valid.includes(level as ThinkingLevel)) {
		return level as ThinkingLevel;
	}
	return "off";
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
// Duration formatting
// ============================================================================

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// ============================================================================
// Render helpers
// ============================================================================

function formatAgentCall(args: AgentToolInput | undefined): string {
	if (!args) return "agent (unknown)";
	const name = args.agent ?? "unknown";
	const desc = args.description ? ` -- ${args.description}` : "";
	const task = args.task ?? "";
	const preview = task.length > 80 ? `${task.slice(0, 77)}...` : task;
	return `agent:${name}${desc}${preview ? `\n${preview}` : ""}`;
}

// ============================================================================
// Tool definition factory
// ============================================================================

export function createAgentToolDefinition(
	options: AgentToolOptions,
): ToolDefinition<typeof agentSchema, AgentToolDetails, AgentRenderState> {
	const {
		cwd,
		agentRegistry,
		parentToolDefinitions,
		streamFn,
		getApiKey,
		model,
		contextFiles,
		defaultMaxCost,
		agentTracker,
		currentDepth = 0,
		maxDepth = 3,
	} = options;

	return {
		name: "agent",
		label: "Agent",
		description:
			"Launch a new agent to handle a focused task autonomously. " +
			"The agent runs with its own conversation context and tool access, returning results when done.\n\n" +
			"IMPORTANT: When the user asks you to use a specific agent (e.g. 'use the explore agent', " +
			"'spawn the code agent', 'have the plan agent...'), you MUST use this tool. Do not do the work yourself.\n\n" +
			"Available agent types are listed in <available_agents> in the system prompt. Each agent has a " +
			"specific tool set and purpose. Use the agent best suited for the task:\n" +
			"- explore: Fast read-only codebase/document exploration\n" +
			"- plan: Architecture analysis and implementation planning\n" +
			"- research: Information gathering and synthesis\n" +
			"- writer: Long-form content and documentation creation\n" +
			"- code: Focused code implementation with full tool access\n\n" +
			"When to use agents without being asked:\n" +
			"- Complex, multi-step tasks that benefit from focused work\n" +
			"- Tasks that can run in parallel with other work\n" +
			"- Tasks outside your primary expertise (e.g. research while coding)\n\n" +
			"When NOT to use agents:\n" +
			"- Tasks requiring back-and-forth with the user\n" +
			"- Tasks that depend on the current conversation context (agents start fresh)",
		promptSnippet: "Launch autonomous subagents for parallel or specialized work",
		promptGuidelines: [
			"CRITICAL: When the user explicitly asks to use an agent by name, ALWAYS use this tool. Never do the work yourself instead.",
			"Use agents when a task is well-scoped and benefits from focused, independent work",
			"For simple tasks where no agent is requested, you may do the work directly",
			"Provide detailed task descriptions with full context so the agent can work independently",
			"You can launch multiple agents in parallel by making multiple agent tool calls in one response",
			"Each agent starts with a fresh conversation -- it cannot see your prior messages or context",
			"Check <available_agents> in the system prompt for available agent types and their tools",
			"Use the explore agent for codebase questions, plan agent for design work, code agent for implementation",
		],
		parameters: agentSchema,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const {
				agent: agentName,
				task,
				context: additionalContext,
				model: modelOverride,
				description: taskDesc,
				maxCost: maxCostOverride,
				run_in_background: runInBackground,
				isolation,
			} = params;
			const startedAt = Date.now();

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
					details: {
						agentName,
						turns: 0,
						totalTokens: 0,
						cost: 0,
						status: "error" as const,
						durationMs: Date.now() - startedAt,
					},
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
					details: {
						agentName,
						turns: 0,
						totalTokens: 0,
						cost: 0,
						status: "error" as const,
						durationMs: Date.now() - startedAt,
					},
				};
			}

			// Resolve model: per-invocation override > agent definition > parent model
			const resolvedModel = resolveModel(modelOverride, resolveModel(agentDef.model, model));

			// Resolve thinking level from agent definition
			const resolvedThinking = resolveThinkingLevel(agentDef.thinking);

			// Resolve cost limit: per-invocation > agent definition > settings default > none
			const resolvedMaxCost = maxCostOverride ?? agentDef.maxCost ?? defaultMaxCost;

			// Resolve tools for the subagent (from FULL parent tool set including extensions)
			const subagentTools: AgentTool[] = [];
			if (agentDef.tools && agentDef.tools.length > 0) {
				for (const toolName of agentDef.tools) {
					const toolDef = parentToolDefinitions.get(toolName);
					if (toolDef) {
						subagentTools.push(wrapToolDefinition(toolDef));
					}
				}
			} else {
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
					model: resolvedModel,
					contextFiles,
					defaultMaxCost,
					agentTracker,
					currentDepth: currentDepth + 1,
					maxDepth,
				});
				subagentTools.push(wrapToolDefinition(nestedAgentToolDef));
			}

			// Worktree isolation: create an isolated copy of the repo
			let effectiveCwd = cwd;
			let worktreeInfo: WorktreeInfo | undefined;

			if (isolation === "worktree") {
				if (!isGitRepo(cwd)) {
					return {
						content: [
							{ type: "text", text: 'Error: Cannot use isolation "worktree" -- not inside a git repository.' },
						],
						details: {
							agentName,
							turns: 0,
							totalTokens: 0,
							cost: 0,
							status: "error" as const,
							durationMs: Date.now() - startedAt,
						},
					};
				}

				try {
					worktreeInfo = createWorktree(cwd, agentName);
					effectiveCwd = worktreeInfo.path;

					// Re-create builtin tools scoped to worktree directory
					const worktreeToolDefs = createAllToolDefinitions(effectiveCwd);
					// Replace builtin tools in subagent tools with worktree-scoped versions
					const builtinNames = new Set(Object.keys(worktreeToolDefs));
					const nonBuiltinTools = subagentTools.filter((t) => !builtinNames.has(t.name));
					subagentTools.length = 0;
					for (const def of Object.values(worktreeToolDefs)) {
						subagentTools.push(wrapToolDefinition(def));
					}
					subagentTools.push(...nonBuiltinTools);
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Error creating worktree: ${errorMsg}` }],
						details: {
							agentName,
							turns: 0,
							totalTokens: 0,
							cost: 0,
							status: "error" as const,
							durationMs: Date.now() - startedAt,
						},
					};
				}
			}

			// Build system prompt (using effective cwd for worktree)
			const systemPrompt = buildAgentSystemPrompt(agentDef, effectiveCwd, contextFiles);

			// Build the full prompt for the agent
			let fullTask = task;
			if (additionalContext) {
				fullTask += `\n\n## Additional Context\n${additionalContext}`;
			}

			// Create the subagent
			const subagent = new Agent({
				initialState: {
					systemPrompt,
					model: resolvedModel,
					thinkingLevel: resolvedThinking,
					tools: subagentTools,
					messages: [],
				},
				streamFn,
				getApiKey,
				toolExecution: "parallel",
			});

			// Helper: run the subagent to completion and return result
			const runToCompletion = async (
				progressCallback?: typeof onUpdate,
				abortSignal?: AbortSignal,
			): Promise<AgentToolResult<AgentToolDetails>> => {
				let turns = 0;
				let aborted = false;
				let maxTurnsReached = false;
				let costLimitReached = false;

				subagent.subscribe((event: AgentEvent) => {
					if (event.type === "turn_end") {
						turns++;

						if (turns >= agentDef.maxTurns) {
							maxTurnsReached = true;
							subagent.abort();
						}

						const usage = aggregateUsage(subagent.state.messages);

						if (resolvedMaxCost !== undefined && usage.cost > resolvedMaxCost) {
							costLimitReached = true;
							subagent.abort();
						}
						progressCallback?.({
							content: [
								{ type: "text", text: `[Agent: ${agentName} | turn ${turns} | ${usage.totalTokens} tokens]` },
							],
							details: {
								agentName,
								description: taskDesc,
								turns,
								totalTokens: usage.totalTokens,
								cost: usage.cost,
								status: "success" as const,
								durationMs: Date.now() - startedAt,
							},
						});
					}

					if (event.type === "tool_execution_start") {
						progressCallback?.({
							content: [
								{ type: "text", text: `[Agent: ${agentName} | turn ${turns} | running ${event.toolName}...]` },
							],
							details: {
								agentName,
								description: taskDesc,
								turns,
								totalTokens: 0,
								cost: 0,
								status: "success" as const,
								durationMs: Date.now() - startedAt,
							},
						});
					}
				});

				if (abortSignal) {
					const onAbort = () => {
						aborted = true;
						subagent.abort();
					};
					if (abortSignal.aborted) {
						onAbort();
					} else {
						abortSignal.addEventListener("abort", onAbort, { once: true });
					}
				}

				try {
					await subagent.prompt(fullTask);
					await subagent.waitForIdle();

					const messages = subagent.state.messages;
					const finalText = extractFinalText(messages);
					const usage = aggregateUsage(messages);
					const durationMs = Date.now() - startedAt;

					let status: AgentToolDetails["status"] = "success";
					let headerNote = "";
					if (aborted) {
						status = "aborted";
						headerNote = " (aborted)";
					} else if (costLimitReached) {
						status = "cost-limit";
						headerNote = ` (stopped at $${resolvedMaxCost?.toFixed(2)} cost limit)`;
					} else if (maxTurnsReached) {
						status = "max-turns";
						headerNote = ` (stopped at ${agentDef.maxTurns} turn limit)`;
					}

					const header = `[Agent: ${agentName} | ${turns} turns | ${usage.totalTokens} tokens | ${formatDuration(durationMs)}${headerNote}]`;

					return {
						content: [{ type: "text", text: `${header}\n\n${finalText}` }],
						details: {
							agentName,
							description: taskDesc,
							turns,
							totalTokens: usage.totalTokens,
							cost: usage.cost,
							status,
							durationMs,
						},
					};
				} catch (error) {
					const durationMs = Date.now() - startedAt;
					const messages = subagent.state.messages;
					const partialText = messages.length > 0 ? extractFinalText(messages) : undefined;
					const usage = messages.length > 0 ? aggregateUsage(messages) : { totalTokens: 0, cost: 0 };

					const errorMsg = error instanceof Error ? error.message : String(error);
					const status: AgentToolDetails["status"] = aborted ? "aborted" : "error";
					const header = `[Agent: ${agentName} | ${status.toUpperCase()} | ${turns} turns | ${formatDuration(durationMs)}]`;
					const body = partialText
						? `${errorMsg}\n\n## Partial results before ${status}:\n\n${partialText}`
						: errorMsg;

					return {
						content: [{ type: "text", text: `${header}\n\n${body}` }],
						details: {
							agentName,
							description: taskDesc,
							turns,
							totalTokens: usage.totalTokens,
							cost: usage.cost,
							status,
							durationMs,
						},
					};
				}
			};

			// Background execution: return immediately, track agent
			if (runInBackground && agentTracker) {
				const completionPromise = runToCompletion(undefined, signal);
				const agentId = agentTracker.register(agentName, subagent, completionPromise, taskDesc);

				return {
					content: [
						{
							type: "text",
							text: `Background agent started. ID: ${agentId} (${agentName}). Use agent_status to check progress or retrieve results.`,
						},
					],
					details: {
						agentName,
						description: taskDesc,
						turns: 0,
						totalTokens: 0,
						cost: 0,
						status: "success" as const,
						durationMs: 0,
					},
				};
			}

			// Foreground execution: run and await result
			const result = await runToCompletion(onUpdate, signal);

			// Worktree cleanup
			if (worktreeInfo) {
				const wtHasChanges = hasChanges(worktreeInfo.path);
				if (!wtHasChanges) {
					// No changes -- clean up automatically
					removeWorktree(cwd, worktreeInfo.path, worktreeInfo.branch);
				} else {
					// Changes exist -- preserve worktree, report in result
					result.details.worktree = {
						path: worktreeInfo.path,
						branch: worktreeInfo.branch,
						hasChanges: true,
					};
					const wtNote = `\n\n[Worktree preserved at ${worktreeInfo.path} (branch: ${worktreeInfo.branch})]`;
					if (result.content.length > 0 && result.content[0].type === "text") {
						(result.content[0] as { type: "text"; text: string }).text += wtNote;
					}
				}
			}

			return result;
		},

		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
				state.turns = 0;
				state.status = "running";
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAgentCall(args));
			return text;
		},

		renderResult(result, options, _theme, context) {
			const state = context.state;
			const details = result.details as AgentToolDetails | undefined;

			// Update state from details
			if (details) {
				state.turns = details.turns;
				state.status = details.status;
			}

			// Live timer while streaming
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

			// Build status line
			const parts: string[] = [];
			if (details) {
				parts.push(`${details.turns} turns`);
				if (details.totalTokens > 0) parts.push(`${details.totalTokens} tokens`);
				const elapsed = state.endedAt
					? formatDuration(state.endedAt - (state.startedAt ?? state.endedAt))
					: state.startedAt
						? formatDuration(Date.now() - state.startedAt)
						: "";
				if (elapsed) parts.push(elapsed);
				if (details.status !== "success") parts.push(details.status);
			}
			const statusLine = parts.length > 0 ? `[${parts.join(" | ")}]\n` : "";

			// Get text content
			const textContent = result.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (options.expanded || options.isPartial) {
				text.setText(`${statusLine}${textContent}`);
			} else {
				// Collapsed: show just the status line + first line of output
				const firstLine = textContent.split("\n").find((l) => l.trim()) ?? "";
				const preview = firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
				text.setText(`${statusLine}${preview}`);
			}
			return text;
		},
	};
}

// ============================================================================
// Convenience exports
// ============================================================================

export function createAgentTool(options: AgentToolOptions): AgentTool<typeof agentSchema, AgentToolDetails> {
	return wrapToolDefinition(createAgentToolDefinition(options));
}
