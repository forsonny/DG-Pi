/**
 * Integration tests for the agent tool runtime behavior.
 * Tests: model resolution, thinking level, abort propagation, max-turns enforcement,
 * onUpdate streaming, context files, error handling, nesting depth limits.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type TextContent,
	type ToolCall,
} from "@dg-forsonny/dg-pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../src/core/agents.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { createAgentToolDefinition } from "../src/core/tools/agent.js";

// ============================================================================
// Mock helpers
// ============================================================================

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, options?: { toolCalls?: ToolCall[] }): AssistantMessage {
	const content: (TextContent | ToolCall)[] = [{ type: "text", text }];
	if (options?.toolCalls) {
		content.push(...options.toolCalls);
	}
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeStreamFn(response: string) {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const msg = createAssistantMessage(response);
			stream.push({ type: "start", partial: msg });
			stream.push({ type: "done", reason: "stop", message: msg });
		});
		return stream;
	};
}

/** Stream function that responds N times with tool calls before final text */
function makeMultiTurnStreamFn(turns: number, finalResponse: string) {
	let callCount = 0;
	return () => {
		callCount++;
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			if (callCount <= turns) {
				// Emit a tool call to trigger another turn
				const msg = createAssistantMessage("", {
					toolCalls: [
						{
							type: "toolCall",
							id: `call-${callCount}`,
							name: "test-tool",
							arguments: { input: `turn-${callCount}` },
						},
					],
				});
				msg.stopReason = "toolUse";
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "toolUse", message: msg });
			} else {
				const msg = createAssistantMessage(finalResponse);
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			}
		});
		return stream;
	};
}

/** Stream that hangs until abort */
function makeHangingStreamFn() {
	return (_model: any, _context: any, options?: any) => {
		const stream = new MockAssistantStream();
		const signal = options?.signal as AbortSignal | undefined;
		const check = () => {
			if (signal?.aborted) {
				stream.push({
					type: "error",
					reason: "aborted",
					error: { ...createAssistantMessage(""), stopReason: "aborted", errorMessage: "Aborted" },
				});
			} else {
				setTimeout(check, 5);
			}
		};
		queueMicrotask(check);
		return stream;
	};
}

function createTestAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
	return {
		name: "test-agent",
		description: "A test agent",
		systemPrompt: "You are a test agent.",
		filePath: "/test/agents/test-agent/AGENT.md",
		baseDir: "/test/agents/test-agent",
		sourceInfo: createSyntheticSourceInfo("/test/agents/test-agent/AGENT.md", { source: "test" }),
		tools: undefined,
		model: undefined,
		thinking: undefined,
		maxTurns: 50,
		maxNesting: 0,
		disableModelInvocation: false,
		...overrides,
	};
}

function createTestToolDef(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `Test tool: ${name}`,
		parameters: Type.Object({ input: Type.Optional(Type.String()) }),
		async execute() {
			return { content: [{ type: "text", text: `${name} result` }], details: undefined };
		},
	};
}

function createBaseOptions(overrides?: Record<string, unknown>) {
	const model = getModel("openai", "gpt-4o-mini");
	const parentToolDefinitions = new Map<string, ToolDefinition>([
		["read", createTestToolDef("read")],
		["bash", createTestToolDef("bash")],
		["edit", createTestToolDef("edit")],
		["write", createTestToolDef("write")],
	]);
	const agentRegistry = new Map<string, AgentDefinition>([["test-agent", createTestAgent()]]);

	return {
		cwd: "/test",
		agentRegistry,
		parentToolDefinitions,
		streamFn: makeStreamFn("Agent completed the task."),
		model,
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("agent tool", () => {
	describe("basic execution", () => {
		it("should execute an agent and return results", async () => {
			const toolDef = createAgentToolDefinition(createBaseOptions());
			const result = await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do something" },
				undefined,
				undefined,
				{} as any,
			);

			expect(result.content).toHaveLength(1);
			const text = (result.content[0] as TextContent).text;
			expect(text).toContain("Agent completed the task.");
			expect(text).toContain("[Agent: test-agent");

			const details = result.details;
			expect(details.agentName).toBe("test-agent");
			expect(details.status).toBe("success");
			expect(details.totalTokens).toBeGreaterThan(0);
			expect(details.durationMs).toBeGreaterThan(0);
		});

		it("should return error for unknown agent", async () => {
			const toolDef = createAgentToolDefinition(createBaseOptions());
			const result = await toolDef.execute(
				"call-1",
				{ agent: "nonexistent", task: "Do something" },
				undefined,
				undefined,
				{} as any,
			);

			const text = (result.content[0] as TextContent).text;
			expect(text).toContain("Error: Unknown agent");
			expect(text).toContain("nonexistent");
			expect(text).toContain("test-agent"); // lists available
			expect(result.details.status).toBe("error");
		});

		it("should include context in agent prompt", async () => {
			let capturedContext: any;
			const streamFn = (_model: any, context: any) => {
				capturedContext = context;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage("Done");
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			};

			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn }));
			await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it", context: "Extra info here" },
				undefined,
				undefined,
				{} as any,
			);

			// The user message should contain the context
			const userMsg = capturedContext.messages.find((m: any) => m.role === "user");
			// Content can be a string or array of content blocks
			const text =
				typeof userMsg.content === "string"
					? userMsg.content
					: userMsg.content.map((c: any) => c.text ?? "").join("");
			expect(text).toContain("Extra info here");
		});
	});

	describe("model resolution", () => {
		it("should use parent model by default", async () => {
			let capturedModel: any;
			const streamFn = (model: any) => {
				capturedModel = model;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const parentModel = getModel("openai", "gpt-4o-mini");
			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn, model: parentModel }));
			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, undefined, {} as any);

			expect(capturedModel.id).toBe("gpt-4o-mini");
		});

		it("should use agent definition model override", async () => {
			let capturedModel: any;
			const streamFn = (model: any) => {
				capturedModel = model;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const agentDef = createTestAgent({ model: "openai/gpt-4o" });
			const registry = new Map([["test-agent", agentDef]]);
			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn, agentRegistry: registry }));
			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, undefined, {} as any);

			expect(capturedModel.id).toBe("gpt-4o");
		});

		it("should prefer per-invocation model override", async () => {
			let capturedModel: any;
			const streamFn = (model: any) => {
				capturedModel = model;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const agentDef = createTestAgent({ model: "openai/gpt-4o" });
			const registry = new Map([["test-agent", agentDef]]);
			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn, agentRegistry: registry }));
			await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it", model: "google/gemini-2.5-flash" },
				undefined,
				undefined,
				{} as any,
			);

			expect(capturedModel.id).toBe("gemini-2.5-flash");
		});

		it("should fall back to parent model on invalid model spec", async () => {
			let capturedModel: any;
			const streamFn = (model: any) => {
				capturedModel = model;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const parentModel = getModel("openai", "gpt-4o-mini");
			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn, model: parentModel }));
			await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it", model: "invalid/nonexistent" },
				undefined,
				undefined,
				{} as any,
			);

			expect(capturedModel.id).toBe("gpt-4o-mini");
		});
	});

	describe("thinking level", () => {
		it("should default thinking to off", async () => {
			let capturedOptions: any;
			const streamFn = (_model: any, _context: any, options: any) => {
				capturedOptions = options;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn }));
			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, undefined, {} as any);

			// reasoning is undefined when thinking is "off"
			expect(capturedOptions?.reasoning).toBeUndefined();
		});

		it("should apply thinking level from agent definition", async () => {
			let capturedOptions: any;
			const streamFn = (_model: any, _context: any, options: any) => {
				capturedOptions = options;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const agentDef = createTestAgent({ thinking: "medium" });
			const registry = new Map([["test-agent", agentDef]]);
			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn, agentRegistry: registry }));
			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, undefined, {} as any);

			expect(capturedOptions?.reasoning).toBe("medium");
		});
	});

	describe("tool resolution", () => {
		it("should filter tools by agent allowlist", async () => {
			let capturedTools: any;
			const streamFn = (_model: any, context: any) => {
				capturedTools = context.tools;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const agentDef = createTestAgent({ tools: ["read", "bash"] });
			const registry = new Map([["test-agent", agentDef]]);
			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn, agentRegistry: registry }));
			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, undefined, {} as any);

			const toolNames = capturedTools.map((t: any) => t.name);
			expect(toolNames).toContain("read");
			expect(toolNames).toContain("bash");
			expect(toolNames).not.toContain("edit");
			expect(toolNames).not.toContain("write");
		});

		it("should inherit all parent tools (except agent) when no allowlist", async () => {
			let capturedTools: any;
			const streamFn = (_model: any, context: any) => {
				capturedTools = context.tools;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const agentDef = createTestAgent({ tools: undefined });
			const registry = new Map([["test-agent", agentDef]]);

			// Add an "agent" tool to parent to verify it's excluded
			const parentTools = new Map<string, ToolDefinition>([
				["read", createTestToolDef("read")],
				["bash", createTestToolDef("bash")],
				["agent", createTestToolDef("agent")],
			]);

			const toolDef = createAgentToolDefinition(
				createBaseOptions({ streamFn, agentRegistry: registry, parentToolDefinitions: parentTools }),
			);
			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, undefined, {} as any);

			const toolNames = capturedTools.map((t: any) => t.name);
			expect(toolNames).toContain("read");
			expect(toolNames).toContain("bash");
			expect(toolNames).not.toContain("agent");
		});
	});

	describe("context files", () => {
		it("should include context files in agent system prompt", async () => {
			let capturedSystemPrompt: string | undefined;
			const streamFn = (_model: any, context: any) => {
				capturedSystemPrompt = context.systemPrompt;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const contextFiles = [
				{ path: "CLAUDE.md", content: "Always use TypeScript strict mode." },
				{ path: "AGENTS.md", content: "Follow coding standards." },
			];

			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn, contextFiles }));
			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, undefined, {} as any);

			expect(capturedSystemPrompt).toContain("Always use TypeScript strict mode.");
			expect(capturedSystemPrompt).toContain("Follow coding standards.");
			expect(capturedSystemPrompt).toContain("Project Context");
		});

		it("should work without context files", async () => {
			let capturedSystemPrompt: string | undefined;
			const streamFn = (_model: any, context: any) => {
				capturedSystemPrompt = context.systemPrompt;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			};

			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn }));
			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, undefined, {} as any);

			expect(capturedSystemPrompt).not.toContain("Project Context");
			expect(capturedSystemPrompt).toContain("test agent");
		});
	});

	describe("nesting depth", () => {
		it("should reject when max depth reached", async () => {
			const toolDef = createAgentToolDefinition(createBaseOptions({ currentDepth: 3, maxDepth: 3 }));
			const result = await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it" },
				undefined,
				undefined,
				{} as any,
			);

			const text = (result.content[0] as TextContent).text;
			expect(text).toContain("Maximum agent nesting depth");
			expect(result.details.status).toBe("error");
		});

		it("should allow execution when under depth limit", async () => {
			const toolDef = createAgentToolDefinition(createBaseOptions({ currentDepth: 1, maxDepth: 3 }));
			const result = await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it" },
				undefined,
				undefined,
				{} as any,
			);

			expect(result.details.status).toBe("success");
		});
	});

	describe("abort propagation", () => {
		it("should abort subagent when parent signal fires", async () => {
			const controller = new AbortController();
			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn: makeHangingStreamFn() }));

			// Start execution, then abort after a short delay
			const resultPromise = toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it" },
				controller.signal,
				undefined,
				{} as any,
			);

			await new Promise((resolve) => setTimeout(resolve, 30));
			controller.abort();

			const result = await resultPromise;
			expect(result.details.status).toBe("aborted");
		});

		it("should handle already-aborted signal", async () => {
			const controller = new AbortController();
			controller.abort(); // Already aborted

			// Use a stream that checks abort immediately
			const streamFn = (_model: any, _context: any, options?: any) => {
				const stream = new MockAssistantStream();
				const signal = options?.signal as AbortSignal | undefined;
				queueMicrotask(() => {
					if (signal?.aborted) {
						stream.push({
							type: "error",
							reason: "aborted",
							error: { ...createAssistantMessage(""), stopReason: "aborted", errorMessage: "Aborted" },
						});
					} else {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
					}
				});
				return stream;
			};

			const toolDef = createAgentToolDefinition(createBaseOptions({ streamFn }));
			const result = await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it" },
				controller.signal,
				undefined,
				{} as any,
			);
			expect(result.details.status).toBe("aborted");
		});
	});

	describe("onUpdate streaming", () => {
		it("should call onUpdate with progress", async () => {
			const updates: any[] = [];
			const onUpdate = (update: any) => {
				updates.push(update);
			};

			// Use a multi-turn stream to generate turn_end events
			const testTool = createTestToolDef("test-tool");
			const parentTools = new Map<string, ToolDefinition>([["test-tool", testTool]]);
			const agentDef = createTestAgent({ tools: ["test-tool"] });
			const registry = new Map([["test-agent", agentDef]]);

			const toolDef = createAgentToolDefinition(
				createBaseOptions({
					streamFn: makeMultiTurnStreamFn(2, "Final result"),
					agentRegistry: registry,
					parentToolDefinitions: parentTools,
				}),
			);

			await toolDef.execute("call-1", { agent: "test-agent", task: "Do it" }, undefined, onUpdate, {} as any);

			// Should have received progress updates
			expect(updates.length).toBeGreaterThan(0);

			// Updates should contain agent name
			const lastUpdate = updates[updates.length - 1];
			expect((lastUpdate.content[0] as TextContent).text).toContain("test-agent");
		});
	});

	describe("details and metadata", () => {
		it("should include description in details when provided", async () => {
			const toolDef = createAgentToolDefinition(createBaseOptions());
			const result = await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do something", description: "Quick test" },
				undefined,
				undefined,
				{} as any,
			);

			expect(result.details.description).toBe("Quick test");
		});

		it("should track duration", async () => {
			const toolDef = createAgentToolDefinition(createBaseOptions());
			const result = await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it" },
				undefined,
				undefined,
				{} as any,
			);

			expect(result.details.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("should aggregate token usage", async () => {
			const toolDef = createAgentToolDefinition(createBaseOptions());
			const result = await toolDef.execute(
				"call-1",
				{ agent: "test-agent", task: "Do it" },
				undefined,
				undefined,
				{} as any,
			);

			expect(result.details.totalTokens).toBe(150); // From mock message usage
			expect(result.details.cost).toBeGreaterThan(0);
		});
	});
});
