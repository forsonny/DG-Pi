> pi can create agents. Ask it to build one for your use case.

# Agents

Agents are autonomous subagents that the main agent spawns for focused, independent tasks. Each agent runs with its own conversation context, system prompt, and tool subset, returning results when done.

## Table of Contents

- [Locations](#locations)
- [How Agents Work](#how-agents-work)
- [Built-in Agents](#built-in-agents)
- [AGENT.md Format](#agentmd-format)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Extension Registration](#extension-registration)
- [Nesting](#nesting)
- [Example](#example)
- [Agents vs Skills](#agents-vs-skills)

## Locations

> **Security:** Agents can instruct the model to perform any action and have access to tools that modify files and run commands. Review agent content before use.

DG-Pi loads agents from:

- Built-in: shipped with the package at `packages/coding-agent/agents/`
- Global: `~/.dg-pi/agent/agents/`
- Project: `.dg-pi/agents/`
- Settings: `agents` array with files or directories
- CLI: `--agent <path>` (repeatable, additive even with `--no-agents`)
- Extensions: via `pi.registerAgent()`

Discovery rules:
- If a directory contains `AGENT.md`, treat it as an agent root and do not recurse further
- Recurse into subdirectories to find `AGENT.md` files
- Directories starting with `.` and `node_modules` are skipped
- `.gitignore`, `.ignore`, and `.fdignore` rules are respected

Disable discovery with `--no-agents` (explicit `--agent` paths still load).

## How Agents Work

1. At startup, DG-Pi scans agent locations and extracts names and descriptions
2. Available agents are listed in the system prompt as an XML `<available_agents>` block
3. The LLM invokes the `agent` tool with an agent name, task description, and optional context
4. Each agent runs as an isolated Agent instance with its own conversation, system prompt, and tools
5. Project context files (AGENTS.md, CLAUDE.md) are included in the subagent's system prompt
6. Progress is streamed to the parent (turn count, current tool, token usage)
7. Results are returned with usage stats: `[Agent: name | N turns | N tokens | duration]`
8. The user can press Escape to abort a running agent (abort propagates to subagent)

This keeps the parent conversation focused while delegating well-scoped work to specialized subagents.

### Agent Tool Parameters

When the LLM invokes the `agent` tool, it provides:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `agent` | Yes | Name of the agent type (from `<available_agents>`) |
| `task` | Yes | Detailed task description |
| `description` | No | Short (3-5 word) summary of what the agent will do |
| `context` | No | Additional context (file contents, prior findings) |
| `model` | No | Model override for this invocation (e.g. `"anthropic/claude-sonnet-4"`) |

## Agent Commands

Agents register as `/agent:name` commands:

```bash
/agent:explore Find all API endpoint definitions    # Invoke explore agent with task
/agent:plan Design a caching layer for the API      # Invoke plan agent with task
```

The command expands into a prompt that instructs the LLM to use the `agent` tool with the named agent.

Toggle agent commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableAgentCommands": true
}
```

## Built-in Agents

| Agent | Description | Tools |
|-------|-------------|-------|
| `explore` | Fast read-only codebase and document exploration | read, grep, find, ls |
| `plan` | Architecture analysis and implementation planning | read, grep, find, ls |
| `research` | Web research and information gathering | read |
| `writer` | Long-form content creation | read, write, edit |
| `code` | Focused code implementation | read, bash, edit, write, grep, find, ls |

## AGENT.md Format

An agent is a directory with an `AGENT.md` file. Everything else is freeform.

```
my-agent/
├── AGENT.md              # Required: frontmatter + system prompt
├── scripts/              # Helper scripts (optional)
│   └── setup.sh
└── references/           # Reference docs (optional)
    └── api-guide.md
```

### AGENT.md Structure

```markdown
---
name: my-agent
description: What this agent does and when to use it. Be specific.
tools:
  - read
  - grep
  - find
max-turns: 30
max-nesting: 0
---

You are a specialized agent. Your job is to...

## Approach

- Step-by-step instructions for the agent.

## Constraints

- What the agent must not do.
```

The frontmatter configures the agent. The body becomes the agent's system prompt.

## Frontmatter

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the agent does and when to use it. |
| `tools` | No | Tool allowlist (YAML list). Omit to inherit all parent tools. |
| `model` | No | Model override, e.g. `anthropic/claude-sonnet-4`. |
| `thinking` | No | Thinking level override. |
| `max-turns` | No | Max agent loop turns. Default: 50. |
| `max-nesting` | No | Whether this agent can spawn sub-agents. Default: 0. |
| `disable-model-invocation` | No | When `true`, agent is hidden from the system prompt. Must be invoked explicitly. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `code-review`, `data-analysis`, `api-tester`
Invalid: `Code-Review`, `-code`, `code--review`

### Description Best Practices

The description determines when the LLM decides to spawn the agent. Be specific about capabilities and use cases.

Good:
```yaml
description: Fast read-only codebase and document exploration. Use for navigating code, finding definitions, tracing dependencies, and understanding project structure without making changes.
```

Poor:
```yaml
description: Explores code.
```

## Validation

DG-Pi validates agents at load time. Most issues produce warnings but still load the agent:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Agents with a missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first agent found. Built-in agents load first, then global, then project.

## Extension Registration

Extensions can register agents programmatically via `pi.registerAgent()`:

```typescript
pi.registerAgent({
	name: "my-custom-agent",
	description: "Description for the LLM to decide when to spawn this agent.",
	systemPrompt: "You are a specialized agent that...",
	tools: ["read", "grep", "find"],
	maxTurns: 30,
	maxNesting: 0,
});
```

All fields from the `AgentRegistration` interface:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent name (lowercase a-z, 0-9, hyphens). |
| `description` | Yes | Short description for the LLM. |
| `systemPrompt` | Yes | The agent's system prompt content. |
| `tools` | No | Tool allowlist. Omit to inherit all parent tools. |
| `model` | No | Model override. |
| `thinking` | No | Thinking level override. |
| `maxTurns` | No | Max turns. Default: 50. |
| `maxNesting` | No | Max sub-agent nesting depth. Default: 0. |
| `disableModelInvocation` | No | If true, hidden from system prompt. |

## Nesting

Agents can spawn sub-agents if their `max-nesting` value is greater than 0. DG-Pi enforces a hard limit of 3 nesting levels regardless of agent configuration.

How nesting depth works:
- The main agent is depth 0
- An agent spawned by the main agent is depth 1
- A sub-agent spawned by that agent is depth 2
- Depth 3 is the hard ceiling; no further spawning is allowed

If an agent has `max-nesting: 0` (the default), it cannot spawn sub-agents at all. The `max-nesting` value is clamped to the hard limit of 3.

All built-in agents ship with `max-nesting: 0` to keep their behavior focused.

## Example

A custom agent for reviewing pull requests:

```
pr-review/
├── AGENT.md
└── references/
    └── review-checklist.md
```

**AGENT.md:**
```markdown
---
name: pr-review
description: Reviews pull request diffs for bugs, style issues, and potential improvements. Use when asked to review code changes or PRs.
tools:
  - read
  - grep
  - find
  - ls
  - bash
max-turns: 30
max-nesting: 0
---

You are a code review agent. You analyze diffs and provide structured, actionable feedback.

## Approach

- Use bash to run `git diff` and examine the changes.
- Use grep and find to understand the surrounding code and conventions.
- Read related test files to check for missing test coverage.
- See [review-checklist.md](references/review-checklist.md) for the full checklist.

## Output

Organize findings by severity:

1. **Bugs** -- correctness issues that will cause failures.
2. **Issues** -- problems that should be fixed but are not blocking.
3. **Suggestions** -- optional improvements.

## Constraints

- Do not modify any files. You are read-only except for bash commands needed to inspect the repo.
- Be specific: reference file paths, line numbers, and code snippets.
- Do not pad feedback with praise. Focus on actionable items.
```

Place this directory in `~/.dg-pi/agent/agents/` for global availability or `.dg-pi/agents/` for a specific project.

## Agents vs Skills

| | Skills | Agents |
|-|--------|--------|
| **Execution** | Instructions loaded into the main conversation context | Autonomous subagents with independent conversation |
| **Tool access** | Use the main agent's tools | Have their own tool subset |
| **Context** | Share the parent conversation's context window | Run with isolated context |
| **State** | No isolated state | Own conversation history, system prompt |
| **Use when** | You need on-demand instructions, workflows, or reference docs | A task is well-scoped and benefits from focused, independent work |
| **Invocation** | LLM reads the SKILL.md or user runs `/skill:name` | LLM calls the `agent` tool |
