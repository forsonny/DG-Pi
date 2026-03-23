import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { type AgentDefinition, formatAgentsForPrompt, loadAgents, loadAgentsFromDir } from "../src/core/agents.js";
import type { ResourceDiagnostic } from "../src/core/diagnostics.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

const fixturesDir = resolve(__dirname, "fixtures/agents");
const collisionFixturesDir = resolve(__dirname, "fixtures/agents-collision");

function createTestAgent(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	tools?: string[];
	maxTurns?: number;
	maxNesting?: number;
	disableModelInvocation?: boolean;
}): AgentDefinition {
	return {
		name: options.name,
		description: options.description,
		systemPrompt: "",
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: "test" }),
		tools: options.tools,
		maxTurns: options.maxTurns ?? 50,
		maxNesting: options.maxNesting ?? 0,
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

describe("agents", () => {
	describe("loadAgentsFromDir", () => {
		it("should load a valid agent", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: join(fixturesDir, "valid-agent"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].name).toBe("valid-agent");
			expect(agents[0].description).toBe("A valid agent for testing purposes.");
			expect(agents[0].tools).toEqual(["read", "grep"]);
			expect(agents[0].maxTurns).toBe(25);
			expect(agents[0].maxNesting).toBe(0);
			expect(agents[0].systemPrompt).toBe("You are a test agent.");
			expect(agents[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should load agent with all frontmatter fields", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: join(fixturesDir, "all-fields"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].name).toBe("all-fields");
			expect(agents[0].tools).toEqual(["read", "bash", "edit"]);
			expect(agents[0].model).toBe("anthropic/claude-sonnet-4");
			expect(agents[0].thinking).toBe("medium");
			expect(agents[0].maxTurns).toBe(30);
			expect(agents[0].maxNesting).toBe(2);
			expect(agents[0].maxCost).toBe(1.5);
			expect(agents[0].disableModelInvocation).toBe(false);
			expect(diagnostics).toHaveLength(0);
		});

		it("should default maxCost to undefined when not specified", () => {
			const { agents } = loadAgentsFromDir({
				dir: join(fixturesDir, "valid-agent"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].maxCost).toBeUndefined();
		});

		it("should warn when name doesn't match parent directory", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(true);
		});

		it("should warn and skip agent when description is missing", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(agents).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should skip files without frontmatter", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			expect(agents).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].name).toBe("disable-model-invocation");
			expect(agents[0].disableModelInvocation).toBe(true);
			expect(diagnostics).toHaveLength(0);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { agents } = loadAgentsFromDir({
				dir: join(fixturesDir, "valid-agent"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].disableModelInvocation).toBe(false);
		});

		it("should load nested agents recursively", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].name).toBe("inner-agent");
			expect(agents[0].tools).toEqual(["read"]);
			expect(agents[0].maxTurns).toBe(10);
			expect(diagnostics).toHaveLength(0);
		});

		it("should return empty for non-existent directory", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(agents).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should return empty for empty directory", () => {
			const { agents, diagnostics } = loadAgentsFromDir({
				dir: join(fixturesDir, "empty-agent"),
				source: "test",
			});

			expect(agents).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should default max-turns to 50 when not specified", () => {
			const { agents } = loadAgentsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].maxTurns).toBe(50);
		});

		it("should default tools to undefined when not specified", () => {
			const { agents } = loadAgentsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(agents).toHaveLength(1);
			expect(agents[0].tools).toBeUndefined();
		});
	});

	describe("loadAgents with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit agentPaths", () => {
			const { agents, diagnostics } = loadAgents({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				agentPaths: [join(fixturesDir, "valid-agent")],
				includeDefaults: false,
			});
			expect(agents).toHaveLength(1);
			expect(agents[0].name).toBe("valid-agent");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when agent path does not exist", () => {
			const { agents, diagnostics } = loadAgents({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				agentPaths: ["/non/existent/path"],
				includeDefaults: false,
			});
			expect(agents).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should load from multiple agentPaths", () => {
			const { agents } = loadAgents({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				agentPaths: [join(fixturesDir, "valid-agent"), join(fixturesDir, "all-fields")],
				includeDefaults: false,
			});
			expect(agents).toHaveLength(2);
			const names = agents.map((a) => a.name).sort();
			expect(names).toEqual(["all-fields", "valid-agent"]);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first agent", () => {
			const first = loadAgentsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadAgentsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			const agentMap = new Map<string, AgentDefinition>();
			const collisionWarnings: Array<{ agentPath: string; message: string }> = [];

			for (const agent of first.agents) {
				agentMap.set(agent.name, agent);
			}

			for (const agent of second.agents) {
				const existing = agentMap.get(agent.name);
				if (existing) {
					collisionWarnings.push({
						agentPath: agent.filePath,
						message: `name collision: "${agent.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					agentMap.set(agent.name, agent);
				}
			}

			expect(agentMap.size).toBe(1);
			expect(agentMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});

	describe("formatAgentsForPrompt", () => {
		it("should return empty string for no agents", () => {
			const result = formatAgentsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format agents as XML", () => {
			const agents: AgentDefinition[] = [
				createTestAgent({
					name: "test-agent",
					description: "A test agent.",
					filePath: "/path/to/agent/AGENT.md",
					baseDir: "/path/to/agent",
					tools: ["read", "grep"],
				}),
			];

			const result = formatAgentsForPrompt(agents);

			expect(result).toContain("<available_agents>");
			expect(result).toContain("</available_agents>");
			expect(result).toContain("<agent>");
			expect(result).toContain("<name>test-agent</name>");
			expect(result).toContain("<description>A test agent.</description>");
			expect(result).toContain("<tools>read, grep</tools>");
		});

		it("should include intro text before XML", () => {
			const agents: AgentDefinition[] = [
				createTestAgent({
					name: "test-agent",
					description: "A test agent.",
					filePath: "/path/to/agent/AGENT.md",
					baseDir: "/path/to/agent",
				}),
			];

			const result = formatAgentsForPrompt(agents);
			const xmlStart = result.indexOf("<available_agents>");
			const introText = result.substring(0, xmlStart);

			expect(introText).toContain("The following agents can be spawned");
			expect(introText).toContain("agent tool");
		});

		it("should escape XML special characters", () => {
			const agents: AgentDefinition[] = [
				createTestAgent({
					name: "test-agent",
					description: 'Agent with <special> & "characters".',
					filePath: "/path/to/agent/AGENT.md",
					baseDir: "/path/to/agent",
				}),
			];

			const result = formatAgentsForPrompt(agents);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple agents", () => {
			const agents: AgentDefinition[] = [
				createTestAgent({
					name: "agent-one",
					description: "First agent.",
					filePath: "/path/one/AGENT.md",
					baseDir: "/path/one",
				}),
				createTestAgent({
					name: "agent-two",
					description: "Second agent.",
					filePath: "/path/two/AGENT.md",
					baseDir: "/path/two",
				}),
			];

			const result = formatAgentsForPrompt(agents);

			expect(result).toContain("<name>agent-one</name>");
			expect(result).toContain("<name>agent-two</name>");
			expect((result.match(/<agent>/g) || []).length).toBe(2);
		});

		it("should exclude agents with disableModelInvocation from prompt", () => {
			const agents: AgentDefinition[] = [
				createTestAgent({
					name: "visible-agent",
					description: "A visible agent.",
					filePath: "/path/visible/AGENT.md",
					baseDir: "/path/visible",
				}),
				createTestAgent({
					name: "hidden-agent",
					description: "A hidden agent.",
					filePath: "/path/hidden/AGENT.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatAgentsForPrompt(agents);

			expect(result).toContain("<name>visible-agent</name>");
			expect(result).not.toContain("<name>hidden-agent</name>");
			expect((result.match(/<agent>/g) || []).length).toBe(1);
		});

		it("should return empty string when all agents have disableModelInvocation", () => {
			const agents: AgentDefinition[] = [
				createTestAgent({
					name: "hidden-agent",
					description: "A hidden agent.",
					filePath: "/path/hidden/AGENT.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatAgentsForPrompt(agents);
			expect(result).toBe("");
		});

		it("should omit tools element when agent has no tools defined", () => {
			const agents: AgentDefinition[] = [
				createTestAgent({
					name: "no-tools",
					description: "Agent without tools.",
					filePath: "/path/to/AGENT.md",
					baseDir: "/path/to",
				}),
			];

			const result = formatAgentsForPrompt(agents);

			expect(result).toContain("<name>no-tools</name>");
			expect(result).not.toContain("<tools>");
		});
	});
});
