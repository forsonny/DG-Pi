# DG-Pi

Fork of [Pi](https://github.com/badlogic/pi-mono) (v0.62.0). Terminal coding agent with multi-provider LLM support.

## Key Info

- **GitHub**: https://github.com/forsonny/DG-Pi
- **npm org**: `@dg-forsonny` (https://www.npmjs.com/org/dg-forsonny)
- **CLI binary**: `dg-pi`
- **Config dir**: `.dg-pi/` (user: `~/.dg-pi/agent/`)
- **Config key in package.json**: `dgPiConfig`
- **Env var prefix**: `DG_PI_*`
- **Current version**: 0.62.0

## Packages

| Package | npm |
|---------|-----|
| `@dg-forsonny/dg-pi-coding-agent` | Main CLI |
| `@dg-forsonny/dg-pi-ai` | Unified LLM API |
| `@dg-forsonny/dg-pi-agent-core` | Agent runtime |
| `@dg-forsonny/dg-pi-tui` | Terminal UI |
| `@dg-forsonny/dg-pi-mom` | Slack bot |
| `@dg-forsonny/dg-pi-web-ui` | Web components |
| `@dg-forsonny/dg-pi-pods` | GPU pod management |

External deps kept as `@mariozechner/*`: `jiti`, `clipboard`, `mini-lit`. Do not rename these.

## Build & Check

```bash
npm install && npm run build    # required before check
npm run check                   # lint + typecheck (must pass before commit)
```

Pre-commit hook runs `npm run check` automatically. `npm run check` requires a prior build for web-ui type resolution.

## Upstream Origin

Forked from `badlogic/pi-mono`. Original author attribution (Mario Zechner) preserved in LICENSE and package.json files per MIT requirements.
