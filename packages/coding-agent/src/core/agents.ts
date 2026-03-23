import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import ignore from "ignore";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getPackageDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

/** Max name length */
const MAX_NAME_LENGTH = 64;

/** Max description length */
const MAX_DESCRIPTION_LENGTH = 1024;

/** Default max turns for agent execution */
const DEFAULT_MAX_TURNS = 50;

/** Default max nesting depth */
const DEFAULT_MAX_NESTING = 0;

/** Hard limit on nesting depth regardless of agent config */
export const MAX_NESTING_DEPTH = 3;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

export interface AgentFrontmatter {
	name?: string;
	description?: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	"max-turns"?: number;
	"max-nesting"?: number;
	"max-cost"?: number;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	tools?: string[];
	model?: string;
	thinking?: string;
	maxTurns: number;
	maxNesting: number;
	maxCost?: number;
	disableModelInvocation: boolean;
}

export interface LoadAgentsResult {
	agents: AgentDefinition[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate agent name.
 * Same rules as skills: lowercase a-z, 0-9, hyphens. Max 64 chars. Must match parent dir.
 */
function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];

	if (name !== parentDirName) {
		errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	}

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadAgentsFromDirOptions {
	/** Directory to scan for agents */
	dir: string;
	/** Source identifier for these agents */
	source: string;
}

function createAgentSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "builtin":
			return createSyntheticSourceInfo(filePath, {
				source: "builtin",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * Load agents from a directory.
 *
 * Discovery rules:
 * - if a directory contains AGENT.md, treat it as an agent root and do not recurse further
 * - recurse into subdirectories to find AGENT.md
 */
export function loadAgentsFromDir(options: LoadAgentsFromDirOptions): LoadAgentsResult {
	const { dir, source } = options;
	return loadAgentsFromDirInternal(dir, source, undefined, undefined);
}

function loadAgentsFromDirInternal(
	dir: string,
	source: string,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadAgentsResult {
	const agents: AgentDefinition[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { agents, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		// Check for AGENT.md in this directory
		for (const entry of entries) {
			if (entry.name !== "AGENT.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadAgentFromFile(fullPath, source);
			if (result.agent) {
				agents.push(result.agent);
			}
			diagnostics.push(...result.diagnostics);
			return { agents, diagnostics };
		}

		// Recurse into subdirectories
		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDirectory = statSync(fullPath).isDirectory();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadAgentsFromDirInternal(fullPath, source, ig, root);
				agents.push(...subResult.agents);
				diagnostics.push(...subResult.diagnostics);
			}
		}
	} catch {}

	return { agents, diagnostics };
}

function loadAgentFromFile(
	filePath: string,
	source: string,
): { agent: AgentDefinition | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(rawContent);
		const agentDir = dirname(filePath);
		const parentDirName = basename(agentDir);

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Use name from frontmatter, or fall back to parent directory name
		const name = frontmatter.name || parentDirName;

		// Validate name
		const nameErrors = validateName(name, parentDirName);
		for (const error of nameErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		// Require description
		if (!frontmatter.description || frontmatter.description.trim() === "") {
			return { agent: null, diagnostics };
		}

		return {
			agent: {
				name,
				description: frontmatter.description,
				systemPrompt: body.trim(),
				filePath,
				baseDir: agentDir,
				sourceInfo: createAgentSourceInfo(filePath, agentDir, source),
				tools: frontmatter.tools,
				model: frontmatter.model,
				thinking: frontmatter.thinking,
				maxTurns: frontmatter["max-turns"] ?? DEFAULT_MAX_TURNS,
				maxNesting: Math.min(frontmatter["max-nesting"] ?? DEFAULT_MAX_NESTING, MAX_NESTING_DEPTH),
				maxCost:
					typeof frontmatter["max-cost"] === "number" && frontmatter["max-cost"] > 0
						? frontmatter["max-cost"]
						: undefined,
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse agent file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { agent: null, diagnostics };
	}
}

/**
 * Format agents for inclusion in a system prompt.
 * Uses XML format similar to skills.
 *
 * Agents with disableModelInvocation=true are excluded from the prompt.
 */
export function formatAgentsForPrompt(agents: AgentDefinition[]): string {
	const visibleAgents = agents.filter((a) => !a.disableModelInvocation);

	if (visibleAgents.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following agents can be spawned via the agent tool for autonomous subtasks.",
		"Use agents when a task is well-scoped and can benefit from focused, independent work.",
		"Prefer doing simple tasks yourself rather than spawning an agent.",
		"",
		"<available_agents>",
	];

	for (const agent of visibleAgents) {
		lines.push("  <agent>");
		lines.push(`    <name>${escapeXml(agent.name)}</name>`);
		lines.push(`    <description>${escapeXml(agent.description)}</description>`);
		if (agent.tools && agent.tools.length > 0) {
			lines.push(`    <tools>${escapeXml(agent.tools.join(", "))}</tools>`);
		}
		lines.push("  </agent>");
	}

	lines.push("</available_agents>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadAgentsOptions {
	/** Working directory for project-local agents. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory for global agents. Default: ~/.dg-pi/agent */
	agentDir?: string;
	/** Explicit agent paths (files or directories) */
	agentPaths?: string[];
	/** Include default agent directories. Default: true */
	includeDefaults?: boolean;
}

function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

function resolveAgentPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Get the directory containing built-in agent definitions shipped with the package.
 */
export function getBuiltinAgentsDir(): string {
	return join(getPackageDir(), "agents");
}

/**
 * Load agents from all configured locations.
 * Returns agents and any validation diagnostics.
 */
export function loadAgents(options: LoadAgentsOptions = {}): LoadAgentsResult {
	const { cwd = process.cwd(), agentDir, agentPaths = [], includeDefaults = true } = options;

	const resolvedAgentDir = agentDir ?? getAgentDir();

	const agentMap = new Map<string, AgentDefinition>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addAgents(result: LoadAgentsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const agent of result.agents) {
			let realPath: string;
			try {
				realPath = realpathSync(agent.filePath);
			} catch {
				realPath = agent.filePath;
			}

			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = agentMap.get(agent.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${agent.name}" collision`,
					path: agent.filePath,
					collision: {
						resourceType: "skill", // reuse "skill" since diagnostics don't have "agent" yet
						name: agent.name,
						winnerPath: existing.filePath,
						loserPath: agent.filePath,
					},
				});
			} else {
				agentMap.set(agent.name, agent);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		// Load built-in agents first (shipped with the package)
		const builtinDir = getBuiltinAgentsDir();
		addAgents(loadAgentsFromDirInternal(builtinDir, "builtin", undefined, undefined));

		// User global agents
		addAgents(loadAgentsFromDirInternal(join(resolvedAgentDir, "agents"), "user", undefined, undefined));

		// Project-local agents
		addAgents(loadAgentsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, "agents"), "project", undefined, undefined));
	}

	const userAgentsDir = join(resolvedAgentDir, "agents");
	const projectAgentsDir = resolve(cwd, CONFIG_DIR_NAME, "agents");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userAgentsDir)) return "user";
			if (isUnderPath(resolvedPath, projectAgentsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of agentPaths) {
		const resolvedPath = resolveAgentPath(rawPath, cwd);
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "agent path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addAgents(loadAgentsFromDirInternal(resolvedPath, source, undefined, undefined));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadAgentFromFile(resolvedPath, source);
				if (result.agent) {
					addAgents({ agents: [result.agent], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "agent path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read agent path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		agents: Array.from(agentMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
