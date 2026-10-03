# Claude Usage for Stream Deck+

A Stream Deck+ dial that shows your Claude Code plan usage: the 5-hour window and the
7-day window, with a progress bar each, for one or more Claude accounts.

![dial layout](com.z4yross.claudeusage.sdPlugin/imgs/plugin/marketplace.png)

## What it does

- **Rotate** switches between the accounts you configured.
- **Tap or short press** swaps the numbers for a prediction: the time the window hits
  100% at the current pace, or the percent it lands on at reset. Tapping again while the
  prediction is up cycles the second row through the 7-day windows the API returns
  (all models, Opus, Sonnet).
- **Hold** (press or touch) opens the usage page at claude.ai in your browser.

The pace is the slope of the last hour of samples. Right after start it falls back to the
average since the window opened.

## How it reads usage

The plugin does not ask you to log in. It reads the OAuth token that Claude Code already
stores in `.credentials.json` inside each config directory and calls the same usage
endpoint Claude Code uses. Tokens are refreshed by Claude Code itself: if the dial says
`login`, open Claude Code with that account once.

Failed accounts are backed off for a few minutes so a dead token never turns into a
rate limit for the live ones.

## Requirements

- Windows 10 or later
- Stream Deck software 6.5 or later, and a Stream Deck+ (the action is dial-only)
- Claude Code installed and logged in (`claude` on PATH is used to read its version)

## Install

Download the latest `com.z4yross.claudeusage.streamDeckPlugin` from the
[releases page](https://github.com/z4yross/streamdeck-claude-usage/releases) and
double-click it.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Accounts | `Claude=~/.claude` | Comma-separated `Label=config dir` pairs. Each dir is a Claude Code config dir (what you pass as `CLAUDE_CONFIG_DIR`). |
| Refresh | 60 s | Poll interval, 30 to 300 s. |

Example with two accounts:

```
Personal=~/.claude,Work=~/.claude-work
```

## Build from source

```bash
npm install
npm run build          # bundles src/ into com.z4yross.claudeusage.sdPlugin/bin
npm run watch          # rebuilds and restarts the plugin on save
npx streamdeck link com.z4yross.claudeusage.sdPlugin   # symlink into Stream Deck
npx streamdeck pack com.z4yross.claudeusage.sdPlugin   # produce the .streamDeckPlugin
```

## License

MIT
