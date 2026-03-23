# DG-Pi Monorepo

> **Looking for the DG-Pi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and managing LLM deployments. Forked from [Pi](https://github.com/badlogic/pi-mono).

## Packages

| Package | Description |
|---------|-------------|
| **[@dg-forsonny/dg-pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@dg-forsonny/dg-pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@dg-forsonny/dg-pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@dg-forsonny/dg-pi-mom](packages/mom)** | Slack bot that delegates messages to the dg-pi coding agent |
| **[@dg-forsonny/dg-pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@dg-forsonny/dg-pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@dg-forsonny/dg-pi-pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./dg-pi-test.sh      # Run dg-pi from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
