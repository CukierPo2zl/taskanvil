# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- README: quickstart now starts with the tunnel, and a new "Running it for real" section covers stable tunnel URLs, launchd and updating

## [0.1.0] - 2026-09-23

First public release.

### Added

- Linear agent session webhook handling with signature verification
- Intake step that extracts declared directives from ticket text and asks for missing required values
- Label handlers in `agent.config.ts` composing worktree, Claude Code session, commit, push and PR primitives
- Per-repository contract in `.claude/agent.json` for directives and commit conventions
- Skill discovery from the repository, `~/.claude/skills` and Claude Code plugins
- Flow editor UI that saves label handlers as node graphs to `.claude/flows/`
- First-run setup page at `/setup` with a one-click Linear OAuth handshake
