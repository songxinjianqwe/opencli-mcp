#!/usr/bin/env node
'use strict';

/**
 * opencli-mcp — MCP server 直连 opencli daemon (端口 19825),给 MCP-aware agent
 * (Claude Code / Cursor / Cline / Claude Desktop) 暴露浏览器操作能力。
 *
 * 设计:全 daemon 直连。daemon 原生支持的 action: tabs/navigate/frames/exec/screenshot/cookies。
 * 其他语义命令(click/type/scroll/back/state/find/get)用 exec + 拼 JS 实现。
 *
 * 关键 trick: 所有 daemon 命令必须传 `workspace: "browser:default"`,
 * 否则 daemon 看不到通用浏览器 automation window 的 tab(它会查找别的 workspace)。
 *
 * 用户 Chrome 中已存的所有登录 cookie (yuque/github/dingtalk/linear/aws/...)
 * 在 automation window 里完全可用 —— 同 profile 共享。
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { execFile } = require('node:child_process');

// ───────────────────── 常量 ─────────────────────

const DAEMON_URL = 'http://127.0.0.1:19825';
const WORKSPACE = 'browser:default';
const DEFAULT_TIMEOUT_MS = 60000;

// ───────────────────── Daemon 直连 ─────────────────────

let _idCounter = 0;
const nextId = () => `mcp-${process.pid}-${Date.now()}-${++_idCounter}`;

async function daemon(action, extra = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = JSON.stringify({
      id: nextId(),
      action,
      workspace: WORKSPACE,
      timeout: Math.ceil(timeoutMs / 1000),
      ...extra,
    });
    const resp = await fetch(`${DAEMON_URL}/command`, {
      method: 'POST',
      headers: { 'X-OpenCLI': '1', 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || `daemon !ok: ${JSON.stringify(json)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

// 包一段表达式成 IIFE,使其总是返回(handles sync expr or async)
const wrapExpr = (code) =>
  `(async()=>{ try { return await (${code}); } catch (_e1) { try { return ${code}; } catch (_e2) { throw _e2; } } })()`;

// ───────────────────── 启动一次性预热(daemon auto-start) ─────────────────────

async function ensureDaemon() {
  // 先探测 daemon 是否已在线，避免每次启动都跑 opencli doctor 触发新 Chrome 窗口
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(`${DAEMON_URL}/status`, {
      headers: { 'X-OpenCLI': '1' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (resp.ok) return; // daemon 已在线，无需 doctor
  } catch {}

  // daemon 没响应，跑 opencli doctor 启动它
  await new Promise((resolve) => {
    const env = { ...process.env, NO_PROXY: '*' };
    for (const k of ['http_proxy','https_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']) delete env[k];
    execFile('opencli', ['doctor'], { timeout: 10000, env, maxBuffer: 1024 * 1024 }, () => resolve());
  });
}

// ───────────────────── MCP wrapper helpers ─────────────────────

const ok = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const image = (base64Png) => ({ content: [{ type: 'image', data: base64Png, mimeType: 'image/png' }] });

// ───────────────────── Tool 定义 ─────────────────────

const TOOLS = [
  // ── Tab 管理 ──────────────────────────────────────────────
  {
    name: 'browser_open',
    description:
      'Open a URL in a NEW tab in opencli automation window (a separate Chrome window sharing your profile). ' +
      'Returns { page, url } — `page` is the tab ID used as `tab_id` by other tools. ' +
      'IMPORTANT: Chrome automatically attaches all your existing login cookies (HttpOnly included), ' +
      'so opening yuque/github/dingtalk/linear/aws/console etc. is immediately authenticated — no setup needed.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL only.' } },
      required: ['url'],
    },
    handler: async ({ url }) => {
      const r = await daemon('tabs', { op: 'new', url });
      return ok({ page: r.page, url: r.data?.url || url });
    },
  },

  {
    name: 'browser_navigate',
    description: 'Navigate an EXISTING tab to a new URL (in-place, no new tab). Returns { page, url, title }.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, tab_id: { type: 'string' } },
      required: ['url', 'tab_id'],
    },
    handler: async ({ url, tab_id }) => {
      const r = await daemon('navigate', { url, page: tab_id });
      return ok({ page: r.page, ...(r.data || {}) });
    },
  },

  {
    name: 'list_tabs',
    description: 'List tabs in opencli automation window. Returns [{ index, page, url, title, active }].',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ok((await daemon('tabs', { op: 'list' })).data),
  },

  {
    name: 'select_tab',
    description: 'Make a tab the active one.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
    handler: async ({ tab_id }) => ok((await daemon('tabs', { op: 'select', page: tab_id })).data),
  },

  {
    name: 'close_tab',
    description: 'Close a tab by its page ID.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
    handler: async ({ tab_id }) => ok((await daemon('tabs', { op: 'close', page: tab_id })).data),
  },

  // ── 内省 ─────────────────────────────────────────────────
  {
    name: 'browser_state',
    description:
      'Get page state: { url, title, viewport, interactive: [{ tag, role, text, ref, attrs }] }. ' +
      'Use this to see what is on the page. Returned `ref` numbers can be used as `target` in click/type.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
    handler: async ({ tab_id }) => {
      const code = `(()=>{
        const inter = [];
        const sels = ['a','button','input','select','textarea','[role="button"]','[role="link"]','[onclick]'];
        document.querySelectorAll(sels.join(',')).forEach((el, i) => {
          if (i >= 100) return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          inter.push({
            ref: i,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 80),
            attrs: { id: el.id || undefined, class: el.className || undefined, href: el.href || undefined, type: el.type || undefined },
          });
        });
        return { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight }, interactive: inter };
      })()`;
      const r = await daemon('exec', { code, page: tab_id });
      return ok(r.data);
    },
  },

  {
    name: 'browser_get',
    description: 'Get page property: "title" | "url" | "html" (page outerHTML) | "text" (element text by selector).',
    inputSchema: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['title', 'url', 'html', 'text'] },
        target: { type: 'string', description: 'CSS selector — required for "text".' },
        tab_id: { type: 'string' },
      },
      required: ['what', 'tab_id'],
    },
    handler: async ({ what, target, tab_id }) => {
      let code;
      if (what === 'title') code = 'document.title';
      else if (what === 'url') code = 'location.href';
      else if (what === 'html') code = 'document.documentElement.outerHTML';
      else if (what === 'text') {
        if (!target) throw new Error('"target" required for what=text');
        code = `(()=>{ const el = document.querySelector(${JSON.stringify(target)}); return el ? (el.innerText||el.textContent||'').trim() : null; })()`;
      }
      const r = await daemon('exec', { code, page: tab_id });
      return ok(r.data);
    },
  },

  {
    name: 'browser_find',
    description:
      'CSS-selector search. Returns { matches_n, entries: [{ tag, attrs, text, visible, nth }] } (max 50 by default).',
    inputSchema: {
      type: 'object',
      properties: {
        css: { type: 'string' },
        limit: { type: 'integer', default: 50 },
        text_max: { type: 'integer', default: 120 },
        tab_id: { type: 'string' },
      },
      required: ['css', 'tab_id'],
    },
    handler: async ({ css, limit = 50, text_max = 120, tab_id }) => {
      const code = `(()=>{
        const els = Array.from(document.querySelectorAll(${JSON.stringify(css)}));
        const total = els.length;
        const out = els.slice(0, ${limit}).map((el, nth) => {
          const r = el.getBoundingClientRect();
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value.length > 200 ? a.value.slice(0, 200) + '...' : a.value;
          return {
            tag: el.tagName.toLowerCase(),
            attrs,
            text: (el.innerText || el.textContent || '').trim().slice(0, ${text_max}),
            visible: r.width > 0 && r.height > 0,
            nth,
          };
        });
        return { matches_n: total, entries: out };
      })()`;
      const r = await daemon('exec', { code, page: tab_id });
      return ok(r.data);
    },
  },

  {
    name: 'browser_frames',
    description: 'List cross-origin iframe targets.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
    handler: async ({ tab_id }) => ok((await daemon('frames', { page: tab_id })).data),
  },

  // ── 交互 ─────────────────────────────────────────────────
  {
    name: 'browser_click',
    description: 'Click an element. `target` is a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' }, tab_id: { type: 'string' } },
      required: ['target', 'tab_id'],
    },
    handler: async ({ target, tab_id }) => {
      const code = `(()=>{
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return { clicked: false, reason: 'element not found' };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, target: ${JSON.stringify(target)} };
      })()`;
      return ok((await daemon('exec', { code, page: tab_id })).data);
    },
  },

  {
    name: 'browser_type',
    description:
      'Focus an input/textarea by CSS selector and set its value (clears first). Dispatches input/change events ' +
      'so framework state updates.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        text: { type: 'string' },
        tab_id: { type: 'string' },
      },
      required: ['target', 'text', 'tab_id'],
    },
    handler: async ({ target, text, tab_id }) => {
      const code = `(()=>{
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return { typed: false, reason: 'element not found' };
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, target: ${JSON.stringify(target)} };
      })()`;
      return ok((await daemon('exec', { code, page: tab_id })).data);
    },
  },

  {
    name: 'browser_select',
    description: 'Select a <select> option by visible text or value.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        option: { type: 'string', description: 'Option visible text or value.' },
        tab_id: { type: 'string' },
      },
      required: ['target', 'option', 'tab_id'],
    },
    handler: async ({ target, option, tab_id }) => {
      const code = `(()=>{
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el || el.tagName !== 'SELECT') return { selected: false, reason: 'not a <select>' };
        const opts = Array.from(el.options);
        const m = opts.find(o => o.value === ${JSON.stringify(option)} || o.text.trim() === ${JSON.stringify(option)});
        if (!m) return { selected: false, reason: 'option not found' };
        el.value = m.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: true, value: m.value };
      })()`;
      return ok((await daemon('exec', { code, page: tab_id })).data);
    },
  },

  {
    name: 'browser_scroll',
    description: 'Scroll the page by amount px (default 500). direction: "up" | "down".',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'integer', default: 500 },
        tab_id: { type: 'string' },
      },
      required: ['direction', 'tab_id'],
    },
    handler: async ({ direction, amount = 500, tab_id }) => {
      const dy = direction === 'up' ? -amount : amount;
      const code = `(()=>{ window.scrollBy(0, ${dy}); return { scrolled: ${dy} }; })()`;
      return ok((await daemon('exec', { code, page: tab_id })).data);
    },
  },

  {
    name: 'browser_back',
    description: 'Browser history back.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
    handler: async ({ tab_id }) => {
      const code = `(()=>{ history.back(); return { ok: true }; })()`;
      return ok((await daemon('exec', { code, page: tab_id })).data);
    },
  },

  // ── 视觉 + 终极原语 ─────────────────────────────────────
  {
    name: 'browser_screenshot',
    description:
      'Capture a PNG screenshot of the active tab. Returns the image inline (visible to multimodal LLMs). ' +
      'NOTE: captures the active tab, not a specific tab_id — use select_tab first if needed.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const r = await daemon('screenshot');
      return image(r.data);
    },
  },

  {
    name: 'exec_in_tab',
    description:
      'Execute arbitrary JavaScript inside a tab and return the result (must be JSON-serializable). ' +
      "THE CORE TOOL for talking to logged-in sites — write `fetch('/api/...', {credentials:'include'})` " +
      "to call any same-origin API with the user's full cookies (incl. HttpOnly). Code can be:\n" +
      '  1. Sync expression: `document.title`\n' +
      '  2. Async IIFE returning Promise: `(async()=>{ const r=await fetch(...); return await r.json(); })()`',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        code: { type: 'string', description: 'JavaScript code (see description for shape).' },
      },
      required: ['tab_id', 'code'],
    },
    handler: async ({ tab_id, code }) => {
      const r = await daemon('exec', { code: wrapExpr(code), page: tab_id });
      return ok(r.data === undefined ? null : r.data);
    },
  },
];

// ───────────────────── MCP server ─────────────────────

const server = new Server(
  { name: 'opencli-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  try {
    return await tool.handler(args || {});
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `[${name}] ${err.message || String(err)}` }] };
  }
});

(async () => {
  // 确保 daemon 在线（已在线则跳过 doctor，避免触发多余 Chrome 窗口）
  await ensureDaemon();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[opencli-mcp] ready (${TOOLS.length} tools, daemon=${DAEMON_URL}, workspace=${WORKSPACE})\n`);
})().catch((e) => {
  process.stderr.write(`[opencli-mcp] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
