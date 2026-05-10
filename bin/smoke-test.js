#!/usr/bin/env node
'use strict';

/**
 * Smoke test: spawn opencli-mcp.js as MCP server (stdio), send initialize + tools/list + a real tool call,
 * verify responses. Exits 0 on success, non-zero on failure.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const MCP = path.join(__dirname, 'opencli-mcp.js');
const proc = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'inherit'] });

const responses = new Map();
let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) {
        const cb = responses.get(msg.id);
        if (cb) { responses.delete(msg.id); cb(msg); }
      }
    } catch (e) {
      console.error('[smoke] non-JSON line:', line);
    }
  }
});

let nextId = 1;
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    responses.set(id, (msg) => {
      if (msg.error) reject(new Error(`${method} error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (responses.has(id)) { responses.delete(id); reject(new Error(`${method} timeout`)); }
    }, 30000);
  });
}

(async () => {
  try {
    console.log('[smoke] initialize...');
    const init = await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    console.log('  serverInfo:', init.serverInfo);

    console.log('[smoke] tools/list...');
    const list = await call('tools/list', {});
    console.log(`  ${list.tools.length} tools:`);
    for (const t of list.tools) console.log(`    - ${t.name}`);
    if (list.tools.length !== 16) throw new Error(`Expected 16 tools, got ${list.tools.length}`);

    console.log('[smoke] tools/call browser_open...');
    const opened = await call('tools/call', {
      name: 'browser_open',
      arguments: { url: 'https://example.com' },
    });
    const openedText = opened.content[0].text;
    console.log('  ', openedText);
    const tabId = JSON.parse(openedText).page;

    console.log('[smoke] tools/call exec_in_tab document.title...');
    const exec = await call('tools/call', {
      name: 'exec_in_tab',
      arguments: { tab_id: tabId, code: 'document.title' },
    });
    console.log('  ', exec.content[0].text);
    if (!exec.content[0].text.includes('Example')) throw new Error('exec_in_tab did not return expected title');

    console.log('[smoke] tools/call browser_get title...');
    const title = await call('tools/call', {
      name: 'browser_get',
      arguments: { what: 'title', tab_id: tabId },
    });
    console.log('  ', title.content[0].text);

    console.log('[smoke] tools/call list_tabs...');
    const tabs = await call('tools/call', { name: 'list_tabs', arguments: {} });
    console.log('  ', tabs.content[0].text.slice(0, 200));

    console.log('[smoke] tools/call close_tab...');
    await call('tools/call', { name: 'close_tab', arguments: { tab_id: tabId } });

    console.log('\n✅ All smoke tests passed');
    proc.kill();
    process.exit(0);
  } catch (e) {
    console.error('\n❌ FAIL:', e.message);
    proc.kill();
    process.exit(1);
  }
})();
