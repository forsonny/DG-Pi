# Changelog

All notable changes to DG-Pi will be documented in this file.

Forked from [Pi v0.62.0](https://github.com/badlogic/pi-mono/releases/tag/v0.62.0).

## [Unreleased]

### Added

- Built-in agent system: autonomous subagents with independent conversation context, tool subsets, and model overrides. Five built-in agents: `explore`, `plan`, `research`, `writer`, `code`. Create custom agents via `AGENT.md` files in `~/.dg-pi/agent/agents/` or `.dg-pi/agents/`, or register them from extensions via `pi.registerAgent()`. CLI flags: `--agent <path>`, `--no-agents`. Settings: `agents[]`, `enableAgentCommands`. See [docs/agents.md](docs/agents.md).
  - TUI rendering with live timer, progress streaming, expandable results
  - Per-invocation model override via `model` parameter in agent tool schema
  - Abort propagation (Escape cancels running agents)
  - Max turns enforcement with partial result recovery
  - Project context files (AGENTS.md, CLAUDE.md) passed to subagents
  - Extension-registered tools accessible to subagents
  - `/agent:name` slash commands with autocomplete
  - Agent thinking level and model override from AGENT.md frontmatter
  - Cost limits: `max-cost` frontmatter, per-invocation `maxCost` parameter, `defaultAgentMaxCost` setting. Agents abort when cost exceeded with "cost-limit" status
  - Background execution: `run_in_background` parameter starts agents asynchronously. `agent_status` companion tool for checking, listing, and aborting background agents
