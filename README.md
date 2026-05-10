# opencli-mcp

MCP server wrapping [opencli](https://github.com/jackwener/opencli) — gives Claude Code / Cursor / Cline / Claude Desktop a complete browser automation tool set, with **automatic access to all your existing Chrome login state** (cookies, including HttpOnly).

## Why this exists

[OpenCLI](https://github.com/jackwener/opencli) is excellent CLI-first browser automation: a Chrome Extension + local daemon + CLI architecture. But the project's stance on MCP is reluctant ([issue #48](https://github.com/jackwener/opencli/issues/48)) — they bet on the AGENT.md / SKILL.md docs-driven philosophy. This wrapper bridges OpenCLI's daemon to the MCP protocol so MCP-aware agents get tool schemas injected at startup with zero learning cost.

## Design

- **Direct daemon connection** — talks to opencli daemon at `127.0.0.1:19825` over HTTP, no `opencli` CLI fork per call. Tool latency is ~10ms (vs 200-500ms with CLI fork).
- **Workspace-aware** — uses `workspace: "browser:default"` for all daemon commands; this is what unlocks visibility into the automation window's tabs.
- **JS-based semantics** — `click`/`type`/`scroll`/`back`/`state`/`find`/`get` are implemented by composing JS and shipping it through `daemon.exec`, avoiding the CLI semantic layer.
- **Cookies stay in Chrome** — we never read `chrome.cookies` or extract cookies. The agent uses `exec_in_tab` to write `fetch(url, {credentials:'include'})` and the browser attaches cookies natively, including HttpOnly.

## Prerequisites

1. Install opencli + Chrome extension (it's our backbone):
   ```bash
   npm install -g @jackwener/opencli
   # then install the Chrome extension from
   # https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk
   opencli doctor   # verify all green
   ```

2. Node ≥ 18.

## Install

```bash
npm install -g @songxinjianqwe/opencli-mcp
```

(or run from source: `node /path/to/opencli-mcp/bin/opencli-mcp.js`)

## Install in Claude Code

This package ships as both an **npm package** and a **Claude Code plugin**. Pick whichever:

### Option A — As a Claude Code plugin (recommended)

The repo doubles as a Claude Code plugin (it has `.claude-plugin/plugin.json` + `.mcp.json` at the root). Three install paths:

**Local (test from your clone):**
```bash
claude --plugin-dir /path/to/opencli-mcp   # session-only, doesn't persist
```

**From a marketplace (after pushing to GitHub):**
```bash
claude plugin marketplace add songxinjianqwe/opencli-mcp
claude plugin install opencli-mcp@opencli-mcp
```

**Validate before publishing:**
```bash
claude plugin validate /path/to/opencli-mcp
```

### Option B — Direct MCP registration (no plugin)

```bash
claude mcp add --scope user opencli -- node /path/to/opencli-mcp/bin/opencli-mcp.js
claude mcp list   # should show "opencli ✓ Connected"
```

For Claude Desktop / Cursor / Cline, follow their MCP registration docs — the server is plain stdio.

## Tools (16)

### Tab management

| Tool | Description |
|---|---|
| `browser_open(url)` | Open URL in a NEW tab. Returns `{page, url}`. Chrome auto-attaches your existing login cookies. |
| `browser_navigate(url, tab_id)` | Navigate an existing tab to a new URL (in-place). |
| `list_tabs()` | List all tabs in the automation window. |
| `select_tab(tab_id)` | Make a tab active. |
| `close_tab(tab_id)` | Close a tab. |

### Inspection

| Tool | Description |
|---|---|
| `browser_state(tab_id)` | Get URL/title/viewport + interactive-elements list. |
| `browser_get(what, target?, tab_id)` | Get title / url / html / text-of-selector. |
| `browser_find(css, limit?, text_max?, tab_id)` | CSS-selector search. |
| `browser_frames(tab_id)` | List cross-origin iframes. |
| `browser_screenshot()` | PNG of active tab (image content for multimodal LLMs). |

### Interaction

| Tool | Description |
|---|---|
| `browser_click(target, tab_id)` | Click element by CSS selector. |
| `browser_type(target, text, tab_id)` | Set input/textarea value with proper events. |
| `browser_select(target, option, tab_id)` | Pick `<select>` option by text or value. |
| `browser_scroll(direction, amount?, tab_id)` | Scroll up/down by px. |
| `browser_back(tab_id)` | Browser history back. |

### The killer tool

| Tool | Description |
|---|---|
| `exec_in_tab(tab_id, code)` | Execute arbitrary JS in a tab. Sync expression OR async IIFE returning a Promise. **Use this with `fetch(..., {credentials:'include'})` to call any same-origin API with the user's full login state, including HttpOnly cookies.** |

## Typical agent workflow

```
User: "看下我语雀最近 5 篇文档"

LLM:
  1. tabId = browser_open("https://www.yuque.com")
       → Chrome already has yuque cookies, fully authenticated
  2. exec_in_tab(tabId, `(async()=>{
       const r = await fetch('/api/v2/users/me/docs?limit=5', {credentials:'include'});
       return await r.json();
     })()`)
       → returns the JSON list directly
  3. close_tab(tabId)
```

No cookie extraction. No keychain prompts. No login flow. Cookies stay in Chrome.

## Limitations

- **Automation window only** — the `list_tabs` returns tabs in opencli's automation window, not your daily Chrome tabs. To "use a logged-in site", `browser_open` it (Chrome auto-attaches cookies from your profile).
- **Single Chrome profile** — uses whatever profile opencli extension is installed in. Multi-profile users need to install the extension in the right one.
- **Active tab for screenshot** — `browser_screenshot` captures the active tab, not arbitrary `tab_id`. Use `select_tab` first.

## License

MIT
