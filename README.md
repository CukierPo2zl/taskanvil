# taskanvil

A Linear agent you configure in code. Assign a ticket to it in Linear, and the label on that ticket decides what happens: which of **your** Claude Code skills runs, with which tools, in which git worktree, and whether the result is committed, pushed, or turned into a pull request.

taskanvil ships no prompts, no skills and no opinions about how your team works. The engine provides primitives; `agent.config.ts` and each repository's `.claude/` folder supply every behavior.

> Status: early. It runs on the author's machine every day, but expect rough edges and breaking changes before 1.0.

## How it works

```
Linear ticket ──▶ webhook ──▶ intake ──▶ label handler ──▶ Claude Code session ──▶ commit / push / PR
   (label,          (agent       (extract          (your code or             (your skill,           (engine
    table,           session)     directives:       a flow drawn             your tool              primitives)
    prose)                        branch, push…)    in the UI)               allowlist)
```

1. **Intake.** A small model reads the ticket and extracts *directives* you declared: branch name, whether to push, extra instructions. Missing required values become a question posted back to the Linear thread.
2. **Routing.** The first matching label picks a handler. Handlers are plain async functions in `agent.config.ts`, or flows drawn in the bundled flow editor and saved to `<repo>/.claude/flows/<label>.json`.
3. **Execution.** The handler composes primitives: create a worktree, run a Claude Code session with a named skill and a tool allowlist, commit, push, open a PR, post to Linear. Every step streams to the Linear session timeline.

Skills are resolved from the target repository (`.claude/skills/<name>/SKILL.md`), then `~/.claude/skills`, then installed Claude Code plugins. A label that names a missing skill fails loudly and lists what is available.

## Requirements

- Node.js 20.11 or newer and pnpm 9 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, with either an Anthropic API key or a subscription token
- A Linear workspace where you can create an OAuth application
- A tunnel that exposes one local port to the internet (ngrok, cloudflared, Tailscale Funnel)

## Quickstart

```sh
git clone https://github.com/CukierPo2zl/taskanvil.git
cd taskanvil
pnpm install
pnpm ui:build
cp .env.example .env
```

### 1. Create the Linear OAuth application

In Linear go to **Settings → API → OAuth applications → Create new**.

- **Redirect URL:** `http://localhost:3456/oauth/callback` (change the port if you set `AGENT_PORT`)
- **Webhooks:** enable them, and turn on the **Agent session events** category. The URL is your tunnel's public URL plus `/linear-webhook`, for example `https://example.ngrok.app/linear-webhook`.
- Copy the **client ID**, **client secret** and **webhook signing secret** into `.env`.

Add your Claude credential to `.env` as well: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

### 2. Start the agent and connect the workspace

```sh
ngrok http 3456        # or your tunnel of choice, in another terminal
pnpm start
```

Open <http://localhost:3456/setup>. The page checks your environment, then a single button runs the OAuth handshake and writes `runtime/tokens.json`. Tokens refresh themselves from then on.

### 3. Register a repository and give it a skill

Open <http://localhost:3456> for the flow editor. Add the local clone the agent should work in. Then make sure the skill your handler names exists, for example:

```
<repo>/.claude/skills/implement/SKILL.md
```

Any Claude Code skill works. If you already have skills in `~/.claude/skills` or from plugins, they are picked up automatically.

### 4. Assign a ticket

Assign a Linear issue to the agent, or mention it. Add a label that matches a handler in `agent.config.ts` or a flow you drew. Watch the session timeline in Linear.

## Configuration

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `LINEAR_CLIENT_ID` | yes | OAuth application client ID |
| `LINEAR_CLIENT_SECRET` | yes | OAuth application client secret |
| `LINEAR_WEBHOOK_SECRET` | yes | Webhook signing secret, used to verify every incoming event |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | one of them | Credential for Claude Code sessions and the intake call |
| `AGENT_PORT` | no | Listen port, default `3456` |
| `AGENT_HOST` | no | Bind address, default `127.0.0.1` |
| `AGENT_PUBLIC_URL` | no | Tunnel URL, only used to display the webhook URL on the setup page |
| `ANTHROPIC_MODEL_INTAKE` | no | Model for directive extraction, default a Haiku snapshot |

Configuration lives in `.env`. Mutable state the agent rotates itself, such as OAuth tokens and session records, lives in `runtime/` and is ignored by git.

### `agent.config.ts`

The heart of the project. It declares:

- **directives**: named values the intake step extracts from tickets, with validation, defaults and an optional question to ask when missing.
- **labels**: one async handler per label, composing `ctx.worktree()`, `ctx.claude()`, `ctx.commit()`, `ctx.push()`, `ctx.openPR()` and `ctx.post.*`.
- **default**: the handler for tickets with no matching label.

The shipped file is a commented example. Its skill names are placeholders you replace.

### Per-repository contract: `.claude/agent.json`

Each registered repository can carry its own directives and commit convention, so conventions travel with the code:

```json
{
  "directives": {
    "ticket": {
      "description": "External ticket number for commit messages, e.g. EXT-4711",
      "validate": "^EXT-\\d+$",
      "required": "ask",
      "ask": "Which EXT ticket should the commits reference?"
    }
  },
  "commit": {
    "format": "{ticket}: {summary}",
    "rules": "Imperative mood. One logical change per commit."
  }
}
```

### Flows

The flow editor at `/` draws label handlers as node graphs and saves them to `<repo>/.claude/flows/<label>.json`. A flow with the same label as a code handler wins. Flows support the same primitives as code plus conditions on edges, so a single label can branch on directives.

## Development

```sh
pnpm dev          # agent with reload
pnpm ui:dev       # flow editor with Vite, proxied to the agent
pnpm test         # vitest
pnpm typecheck    # tsc for the agent and the UI
pnpm lint         # biome
pnpm format       # biome, writing fixes
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how changes are reviewed.

## Security model

- The agent binds to localhost. Only the webhook path needs to be reachable from the internet, through your tunnel.
- Every webhook is verified against the signing secret before it is parsed.
- Claude Code sessions run with the exact tool allowlist your handler passes. Pushing requires an explicit `ctx.push()` call, and by default only when the ticket asks for it.
- Tokens are written with owner-only permissions. Nothing in `runtime/` is ever committed.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Acknowledgements

taskanvil started as a from-scratch rebuild of ideas in [Cyrus](https://github.com/ceedaragents/cyrus), an Apache-2.0 Linear agent. No Cyrus code is included, but its approach to Linear agent sessions shaped this design.

## License

[MIT](LICENSE) © Adrian Oleszczak
