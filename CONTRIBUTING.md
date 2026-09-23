# Contributing

Thanks for taking the time. This is a small project with a single maintainer, so the process is light.

## Before you start

- **Bugs**: open an issue with the steps to reproduce, what you expected, and what happened. Include the agent log line for the session if you have one, with secrets removed.
- **Features**: open an issue first for anything beyond a small fix. taskanvil deliberately ships no skills or prompts, so proposals that add opinionated behavior to the engine will usually be redirected to `agent.config.ts` or a per-repository `.claude/` folder.

## Making changes

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

All three must pass. CI runs the same commands.

- Keep pull requests focused on one change.
- Add or update tests for engine behavior in `src/`. The flow editor UI is tested manually for now.
- Match the existing style. `pnpm format` applies it for you.
- Write commit messages in the imperative mood and explain *why* in the body when it is not obvious.

## Project layout

| Path | What lives there |
| --- | --- |
| `agent.config.ts` | The example agent definition users edit |
| `src/` | The engine: webhook handling, intake, orchestration, git, Claude runner |
| `web/` | The flow editor, a Vite and React app served by the agent |
| `scripts/` | Developer utilities |
| `runtime/` | Mutable state created at runtime, ignored by git |

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
