import type { TextContent } from "@dg-forsonny/dg-pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentToolDetails } from "../src/core/tools/agent.js";
import { createAgentStatusToolDefinition } from "../src/core/tools/agent-status.js";
import { AgentTracker } from "../src/core/tools/agent-tracker.js";

// ============================================================================
// Mock helpers
// ============================================================================

function mockResult(text: string): { content: Array<{ type: "text"; text: string }>; details: AgentToolDetails } {
	return {
		content: [{ type: "text", text }],
		details: {
			agentName: "test-agent",
			turns: 1,
			totalTokens: 100,
			cost: 0.001,
			status: "success",
			durationMs: 50,
		},
	};
}

function createMockAgent() {
	// Minimal mock of Agent with abort()
	return {
		abort: () => {},
		state: { messages: [], isStreaming: false },
	} as any;
}

// ============================================================================
// Tests
// ============================================================================

describe("agent_status tool", () => {
	it("should list all tracked agents", async () => {
		const tracker = new AgentTracker();
		const agent1 = createMockAgent();
		const agent2 = createMockAgent();

		tracker.register("explore", agent1, Promise.resolve(mockResult("Result 1")), "Find files");
		tracker.register("code", agent2, Promise.resolve(mockResult("Result 2")), "Write code");

		// Wait for promises to settle
		await new Promise((r) => setTimeout(r, 10));

		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute("call-1", { action: "list" }, undefined, undefined, {} as any);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("Background agents (2)");
		expect(text).toContain("agent-1");
		expect(text).toContain("agent-2");
		expect(text).toContain("explore");
		expect(text).toContain("code");
		expect(result.details.agentCount).toBe(2);

		tracker.dispose();
	});

	it("should return empty list when no agents", async () => {
		const tracker = new AgentTracker();
		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute("call-1", { action: "list" }, undefined, undefined, {} as any);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("No background agents");
		expect(result.details.agentCount).toBe(0);

		tracker.dispose();
	});

	it("should check a completed agent and return result", async () => {
		const tracker = new AgentTracker();
		const agent = createMockAgent();
		tracker.register("explore", agent, Promise.resolve(mockResult("Found 5 files.")));

		// Wait for completion
		await new Promise((r) => setTimeout(r, 10));

		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute(
			"call-1",
			{ agent_id: "agent-1", action: "check" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("explore");
		expect(text).toContain("Found 5 files.");

		tracker.dispose();
	});

	it("should check a running agent and show status", async () => {
		const tracker = new AgentTracker();
		const agent = createMockAgent();

		// Create a promise that won't resolve
		const neverResolve = new Promise<any>(() => {});
		tracker.register("explore", agent, neverResolve, "Searching");

		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute(
			"call-1",
			{ agent_id: "agent-1", action: "check" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("still running");
		expect(text).toContain("explore");

		tracker.dispose();
	});

	it("should abort a running agent", async () => {
		const tracker = new AgentTracker();
		let aborted = false;
		const agent = {
			abort: () => {
				aborted = true;
			},
			state: { messages: [], isStreaming: true },
		} as any;

		// Resolve after abort
		const resolveOnAbort = new Promise<any>((resolve) => {
			const check = () => {
				if (aborted) resolve(mockResult("Aborted."));
				else setTimeout(check, 5);
			};
			check();
		});
		tracker.register("explore", agent, resolveOnAbort);

		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute(
			"call-1",
			{ agent_id: "agent-1", action: "abort" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("aborted");
		expect(aborted).toBe(true);

		tracker.dispose();
	});

	it("should error on unknown agent ID", async () => {
		const tracker = new AgentTracker();
		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute(
			"call-1",
			{ agent_id: "agent-99", action: "check" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("No agent found");
		expect(text).toContain("agent-99");

		tracker.dispose();
	});

	it("should error when agent_id missing for check action", async () => {
		const tracker = new AgentTracker();
		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute("call-1", { action: "check" }, undefined, undefined, {} as any);

		// With no agent_id and action=check, falls through to list
		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("No background agents");

		tracker.dispose();
	});

	it("should send_message to a completed agent and get new response", async () => {
		const tracker = new AgentTracker();

		// Create a mock agent that responds to prompt()
		let promptCount = 0;
		const agent = {
			abort: () => {},
			state: {
				messages: [
					{ role: "user", content: "First task", timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "text", text: "First response" }],
						usage: { totalTokens: 100, cost: { total: 0.001 } },
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
				isStreaming: false,
			},
			prompt: async (msg: any) => {
				promptCount++;
				// Simulate adding the new exchange to messages
				agent.state.messages.push(
					{ role: "user", content: typeof msg === "string" ? msg : msg.content, timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "text", text: "Follow-up response" }],
						usage: { totalTokens: 50, cost: { total: 0.001 } },
						stopReason: "stop",
						timestamp: Date.now(),
					},
				);
			},
			waitForIdle: async () => {},
		} as any;

		tracker.register("explore", agent, Promise.resolve(mockResult("First response")));
		await new Promise((r) => setTimeout(r, 10)); // Let completion settle

		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute(
			"call-1",
			{ agent_id: "agent-1", action: "send_message", message: "Now do something else" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("Follow-up response");
		expect(text).toContain("resumed");
		expect(promptCount).toBe(1);

		tracker.dispose();
	});

	it("should steer a running agent with send_message", async () => {
		const tracker = new AgentTracker();

		let steeredMessage: any;
		const agent = {
			abort: () => {},
			state: { messages: [], isStreaming: true },
			steer: (msg: any) => {
				steeredMessage = msg;
			},
		} as any;

		const neverResolve = new Promise<any>(() => {});
		tracker.register("code", agent, neverResolve);

		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute(
			"call-1",
			{ agent_id: "agent-1", action: "send_message", message: "Focus on tests" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("queued");
		expect(steeredMessage).toBeDefined();
		expect(steeredMessage.content).toBe("Focus on tests");

		tracker.dispose();
	});

	it("should error on send_message without message", async () => {
		const tracker = new AgentTracker();
		const agent = createMockAgent();
		tracker.register("explore", agent, Promise.resolve(mockResult("Done")));
		await new Promise((r) => setTimeout(r, 10));

		const toolDef = createAgentStatusToolDefinition({ agentTracker: tracker });
		const result = await toolDef.execute(
			"call-1",
			{ agent_id: "agent-1", action: "send_message" },
			undefined,
			undefined,
			{} as any,
		);

		const text = (result.content[0] as TextContent).text;
		expect(text).toContain("'message' is required");

		tracker.dispose();
	});
});
