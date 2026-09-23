# Security policy

taskanvil runs Claude Code sessions with git and shell access on your machine, driven by text in Linear tickets. Please take reports seriously and report them privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for anything that could be exploited.

Include what you found, how to reproduce it, and what an attacker could achieve. You will get an acknowledgement within a week.

## Scope

In scope:

- Webhook verification bypass or replay
- OAuth flow weaknesses, including state handling and token storage
- Prompt injection paths that let ticket content escalate beyond the tool allowlist a handler grants
- Path traversal or command injection through directives, labels, flow definitions or repository settings

Out of scope:

- Behavior of skills you author yourself
- Issues in Linear, Anthropic, or Claude Code themselves; report those upstream
- Running the agent bound to a public interface, which the defaults prevent

## Supported versions

Only the latest release on `main` receives fixes.
