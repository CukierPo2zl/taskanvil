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
- A tunnel that exposes one local port to the internet, with a stable URL (see [Running it for real](#running-it-for-real))

## Quickstart

```sh
git clone https://github.com/CukierPo2zl/taskanvil.git
cd taskanvil
pnpm install
pnpm ui:build
cp .env.example .env
```

### 1. Expose one port to the internet

Linear delivers webhooks over the internet, and taskanvil runs on your machine, so one port has to be reachable. The agent itself keeps listening on localhost; the tunnel forwards to it.

The quickest path is ngrok with the free static domain every account gets:

```sh
brew install ngrok                       # or download from ngrok.com
ngrok config add-authtoken <token>       # from dashboard.ngrok.com
ngrok http --url=<your-name>.ngrok-free.app 3456
```

Claim the domain under **Domains** in the ngrok dashboard first. Without `--url`, ngrok assigns a random hostname that changes on every restart, and each change silently breaks the webhook you configure in the next step. See [Running it for real](#running-it-for-real) for alternatives and for keeping the tunnel alive.

Put the resulting URL in `.env` as `AGENT_PUBLIC_URL` so the setup page can show you the exact webhook address.

### 2. Create the Linear OAuth application

In Linear go to **Settings → API → OAuth applications → Create new**.

- **Redirect URL:** `http://localhost:3456/oauth/callback` (change the port if you set `AGENT_PORT`)
- **Webhooks:** enable them, and turn on the **Agent session events** category. The URL is your tunnel URL plus `/linear-webhook`, for example `https://your-name.ngrok-free.app/linear-webhook`.
- Copy the **client ID**, **client secret** and **webhook signing secret** into `.env`.

Add your Claude credential to `.env` as well: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

### 3. Start the agent and connect the workspace

```sh
pnpm start
```

Open <http://localhost:3456/setup>. The page checks your environment, then a single button runs the OAuth handshake and writes `runtime/tokens.json`. Tokens refresh themselves from then on.

### 4. Register a repository and give it a skill

Open <http://localhost:3456> for the flow editor. Add the local clone the agent should work in. Then make sure the skill your handler names exists, for example:

```
<repo>/.claude/skills/implement/SKILL.md
```

Any Claude Code skill works. If you already have skills in `~/.claude/skills` or from plugins, they are picked up automatically.

### 5. Assign a ticket

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

## Running it for real

The quickstart gets a session working in two terminals. For daily use you want the tunnel and the agent to survive closing the terminal and rebooting, and the public URL to never change.

### Choosing a tunnel

| Option | Stable URL | Cost | Notes |
| --- | --- | --- | --- |
| ngrok static domain | yes | free tier includes one | Easiest. Rate-limited on the free plan, but agent webhooks are a handful of requests per ticket. |
| cloudflared | yes | free with a domain you own | Runs as a service, no per-connection limits. Needs a Cloudflare-managed DNS zone. |
| Tailscale Funnel | yes | free | Good if you already use Tailscale. URL is under `ts.net`. |
| ngrok random URL | **no** | free | Fine for a first test only. Every restart changes the hostname and the Linear webhook stops arriving until you update it. |

Whatever you pick, the webhook URL you enter in Linear must match the tunnel exactly, and only the `/linear-webhook` path is ever called from outside. Every request is verified with the signing secret, so a guessable URL is not a problem.

Example cloudflared setup once you have a domain on Cloudflare:

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create taskanvil
cloudflared tunnel route dns taskanvil agent.example.com
cloudflared tunnel run --url http://localhost:3456 taskanvil
```

Then set `AGENT_PUBLIC_URL=https://agent.example.com` and use `https://agent.example.com/linear-webhook` in Linear.

### Keeping it running on macOS

Both the tunnel and the agent can run as user agents under launchd, which starts them at login and restarts them if they crash. Two plist files in `~/Library/LaunchAgents`:

`~/Library/LaunchAgents/dev.taskanvil.agent.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.taskanvil.agent</string>
  <key>WorkingDirectory</key><string>/Users/you/taskanvil</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/pnpm</string><string>start</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/taskanvil/runtime/agent.log</string>
  <key>StandardErrorPath</key><string>/Users/you/taskanvil/runtime/agent.log</string>
</dict></plist>
```

`~/Library/LaunchAgents/dev.taskanvil.tunnel.plist` is the same shape with `ProgramArguments` set to your tunnel command, for example `/opt/homebrew/bin/ngrok`, `http`, `--url=your-name.ngrok-free.app`, `3456`.

Load them once:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.taskanvil.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.taskanvil.tunnel.plist
```

Useful afterwards:

```sh
launchctl kickstart -k gui/$(id -u)/dev.taskanvil.agent   # restart after changing agent.config.ts or .env
tail -f runtime/agent.log                                  # follow the log
launchctl bootout gui/$(id -u)/dev.taskanvil.agent         # stop and unload
```

The `PATH` entry matters: launchd does not read your shell profile, so without it pnpm cannot find node, and Claude Code sessions cannot find `claude`, `git` or `gh`.

On Linux the equivalent is a systemd user unit with `Restart=always` and `WorkingDirectory` set to the checkout. Docker is deliberately not the recommended path: the agent needs your git identity, your Claude Code login and your local clones, all of which live in your home directory.

### Updating

```sh
git pull
pnpm install
pnpm ui:build
launchctl kickstart -k gui/$(id -u)/dev.taskanvil.agent
```

Tokens in `runtime/` survive updates. Read the changelog before pulling across a minor version, since the config surface may change before 1.0.

### What runs where

- **Your machine:** the agent, the tunnel client, Claude Code sessions, git worktrees. Only the agent's webhook path is exposed.
- **Linear:** sends agent session events, receives activities and responses.
- **Anthropic:** receives the intake extraction call and the Claude Code session traffic, under your own key or subscription.

Nothing else is involved. There is no hosted component and no telemetry.

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
