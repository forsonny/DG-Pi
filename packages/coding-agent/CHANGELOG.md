# Changelog

All notable changes to DG-Pi will be documented in this file.

Forked from [Pi v0.62.0](https://github.com/badlogic/pi-mono/releases/tag/v0.62.0).

## [Unreleased]

### Added

- Built-in agent system: autonomous subagents with independent conversation context, tool subsets, and model overrides. Five built-in agents: `explore`, `plan`, `research`, `writer`, `code`. Create custom agents via `AGENT.md` files in `~/.dg-pi/agent/agents/` or `.dg-pi/agents/`, or register them from extensions via `pi.registerAgent()`. CLI flags: `--agent <path>`, `--no-agents`. Settings: `agents` array. See [docs/agents.md](docs/agents.md).
