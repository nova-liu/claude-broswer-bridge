// Background service worker — CDP-powered tool execution
// All tools run here via chrome.debugger (no content script)

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ─── CDP Session Manager ───────────────────────────────────────────

interface CdpSession {
  tabId: number;
  attached: boolean;
}

const sessions = new Map<number, CdpSession>();

async function ensureAttached(tabId: number): Promise<void> {
  const existing = sessions.get(tabId);
  if (existing?.attached) return;

  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(`Cannot attach debugger: ${chrome.runtime.lastError.message}`));
        return;
      }
      sessions.set(tabId, { tabId, attached: true });

      // Enable domains
      Promise.all([
        sendCdp(tabId, 'Page.enable'),
        sendCdp(tabId, 'Runtime.enable'),
        sendCdp(tabId, 'Network.enable'),
        sendCdp(tabId, 'DOM.enable'),
      ]).then(() => resolve()).catch(() => resolve()); // non-fatal
    });
  });
}

function sendCdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    sessions.delete(source.tabId);
    clearBuffers(source.tabId);
  }
});

// ─── Event Buffers ─────────────────────────────────────────────────

interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  line?: number;
  timestamp: number;
}

interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  type?: string;
  timestamp: number;
}

const consoleBuffers = new Map<number, ConsoleEntry[]>();
const networkBuffers = new Map<number, NetworkEntry[]>();
const MAX_BUFFER = 200;

// Track request IDs to match response info
const pendingRequests = new Map<string, { url: string; method: string; timestamp: number }>();

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;

  if (method === 'Runtime.consoleAPICalled') {
    const p = params as { type: string; args: Array<{ value?: unknown; description?: string; type?: string }>; stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> } };
    const text = p.args.map(a => String(a.value ?? a.description ?? a.type ?? '')).join(' ');
    const frame = p.stackTrace?.callFrames?.[0];
    const buf = consoleBuffers.get(tabId) ?? [];
    buf.push({ level: p.type, text, url: frame?.url, line: frame?.lineNumber, timestamp: Date.now() });
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
    consoleBuffers.set(tabId, buf);
  }

  if (method === 'Runtime.exceptionThrown') {
    const p = params as { exceptionDetails: { text?: string; exception?: { description?: string; value?: unknown }; url?: string; lineNumber?: number } };
    const text = p.exceptionDetails.exception?.description ?? p.exceptionDetails.text ?? 'Unknown exception';
    const buf = consoleBuffers.get(tabId) ?? [];
    buf.push({ level: 'error', text, url: p.exceptionDetails.url, line: p.exceptionDetails.lineNumber, timestamp: Date.now() });
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
    consoleBuffers.set(tabId, buf);
  }

  if (method === 'Network.requestWillBeSent') {
    const p = params as { requestId: string; request: { url: string; method: string } };
    pendingRequests.set(p.requestId, { url: p.request.url, method: p.request.method, timestamp: Date.now() });
  }

  if (method === 'Network.responseReceived') {
    const p = params as { requestId: string; response: { status: number; statusText: string; url: string; mimeType?: string } };
    const pending = pendingRequests.get(p.requestId);
    const buf = networkBuffers.get(tabId) ?? [];
    buf.push({
      url: p.response.url,
      method: pending?.method ?? 'GET',
      status: p.response.status,
      statusText: p.response.statusText,
      type: p.response.mimeType,
      timestamp: pending?.timestamp ?? Date.now(),
    });
    if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
    networkBuffers.set(tabId, buf);
    pendingRequests.delete(p.requestId);
  }

  if (method === 'Network.loadingFailed') {
    const p = params as { requestId: string; errorText: string };
    const pending = pendingRequests.get(p.requestId);
    if (pending) {
      const buf = networkBuffers.get(tabId) ?? [];
      buf.push({
        url: pending.url,
        method: pending.method,
        status: 0,
        statusText: p.errorText,
        timestamp: pending.timestamp,
      });
      if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
      networkBuffers.set(tabId, buf);
      pendingRequests.delete(p.requestId);
    }
  }
});

function clearBuffers(tabId: number) {
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
}

// ─── Tool Implementations ──────────────────────────────────────────

async function getActiveTabId(): Promise<number> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        reject(new Error('No active tab available'));
        return;
      }
      if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
        reject(new Error(`Cannot access restricted page: ${tab.url}`));
        return;
      }
      resolve(tab.id);
    });
  });
}

// --- page_snapshot (Accessibility Tree) ---

interface AXNode {
  nodeId: string;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  description?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

async function pageSnapshot(tabId: number): Promise<string> {
  const { nodes } = await sendCdp(tabId, 'Accessibility.getFullAXTree') as { nodes: AXNode[] };

  // Build parent-child map
  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Find root nodes (no parent)
  const roots: AXNode[] = [];
  for (const node of nodes) {
    if (!node.parentId || !nodeMap.has(node.parentId)) {
      roots.push(node);
    }
  }

  // Assign ref tokens to interactive nodes
  let refCounter = 0;
  const refMap = new Map<string, string>(); // nodeId -> ref
  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
    'slider', 'spinbutton', 'searchbox', 'option', 'scrollbar',
  ]);

  for (const node of nodes) {
    const role = node.role?.value ?? '';
    if (interactiveRoles.has(role) || node.backendDOMNodeId) {
      if (interactiveRoles.has(role)) {
        refMap.set(node.nodeId, `e${refCounter++}`);
      }
    }
  }

  // Format tree
  const lines: string[] = [];
  let totalLen = 0;

  function formatNode(node: AXNode, depth: number) {
    if (totalLen > 100000) return;

    const role = node.role?.value ?? 'generic';
    const name = node.name?.value ?? '';
    const value = node.value?.value ?? '';
    const ref = refMap.get(node.nodeId);

    // Skip anonymous/ignorable nodes
    if (role === 'none' || role === 'generic' || role === 'InlineTextBox') {
      // But still recurse into children
      for (const childId of node.childIds ?? []) {
        const child = nodeMap.get(childId);
        if (child) formatNode(child, depth);
      }
      return;
    }

    // Build description
    const indent = '  '.repeat(depth);
    let desc = `${indent}${role}`;
    if (name) desc += ` ${JSON.stringify(name)}`;
    if (value && value !== name) desc += ` [value=${JSON.stringify(value)}]`;
    if (ref) desc += ` [ref=${ref}]`;

    // Add state properties
    const props = node.properties ?? [];
    const states: string[] = [];
    for (const prop of props) {
      if (prop.name === 'focused' && prop.value.value) states.push('focused');
      if (prop.name === 'disabled' && prop.value.value) states.push('disabled');
      if (prop.name === 'checked' && prop.value.value) states.push('checked');
      if (prop.name === 'expanded' && prop.value.value) states.push('expanded');
      if (prop.name === 'selected' && prop.value.value) states.push('selected');
      if (prop.name === 'level' && prop.value.value) states.push(`level=${prop.value.value}`);
    }
    if (states.length > 0) desc += ` [${states.join(', ')}]`;

    totalLen += desc.length + 1;
    lines.push(desc);

    // Recurse children
    for (const childId of node.childIds ?? []) {
      const child = nodeMap.get(childId);
      if (child) formatNode(child, depth + 1);
    }
  }

  for (const root of roots) {
    formatNode(root, 0);
  }

  // Store ref map for this tab for click/type operations
  refMaps.set(tabId, refMap);
  axNodeMaps.set(tabId, nodeMap);

  let result = lines.join('\n');
  if (result.length > 100000) {
    result = result.slice(0, 100000) + '\n[...truncated]';
  }
  return result;
}

const refMaps = new Map<number, Map<string, string>>();
const axNodeMaps = new Map<number, Map<string, AXNode>>();

async function resolveRef(tabId: number, ref: string): Promise<{ x: number; y: number }> {
  const refMap = refMaps.get(tabId);
  const nodeMap = axNodeMaps.get(tabId);
  if (!refMap || !nodeMap) throw new Error('No snapshot data — run page_snapshot first');

  // Find nodeId for this ref
  let targetNodeId: string | undefined;
  for (const [nodeId, r] of refMap) {
    if (r === ref) { targetNodeId = nodeId; break; }
  }
  if (!targetNodeId) throw new Error(`Ref ${ref} not found — run page_snapshot again`);

  const node = nodeMap.get(targetNodeId);
  if (!node?.backendDOMNodeId) throw new Error(`Ref ${ref} has no DOM node`);

  // Resolve to object and get box model
  const { object } = await sendCdp(tabId, 'DOM.resolveNode', {
    backendNodeId: node.backendDOMNodeId,
  }) as { object: { objectId: string } };

  const { model } = await sendCdp(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    }`,
    returnByValue: true,
  }) as { model: { value: { x: number; y: number; w: number; h: number } } };

  if (model.value.w === 0 && model.value.h === 0) {
    throw new Error(`Ref ${ref} element is not visible (zero-size bounding rect)`);
  }

  return model.value;
}

// --- click ---

async function clickElement(tabId: number, ref: string): Promise<string> {
  const pos = await resolveRef(tabId, ref);

  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1,
  });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1,
  });

  return `Clicked element [ref=${ref}] at (${Math.round(pos.x)}, ${Math.round(pos.y)})`;
}

// --- type ---

async function typeText(tabId: number, ref: string, text: string): Promise<string> {
  // Focus the element first
  const pos = await resolveRef(tabId, ref);
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1,
  });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1,
  });

  // Small delay for focus to settle
  await new Promise(r => setTimeout(r, 50));

  // Insert text
  await sendCdp(tabId, 'Input.insertText', { text });

  return `Typed "${text}" into element [ref=${ref}]`;
}

// --- navigate ---

async function navigate(tabId: number, url: string): Promise<string> {
  await sendCdp(tabId, 'Page.navigate', { url });
  return `Navigating to ${url}`;
}

// --- scroll ---

async function scrollPage(tabId: number, direction: string, amount: number): Promise<string> {
  const deltaY = direction === 'up' ? -amount : amount;
  // Get viewport center
  const { result: viewport } = await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `({ w: window.innerWidth, h: window.innerHeight, y: window.scrollY })`,
    returnByValue: true,
  }) as { result: { value: { w: number; h: number; y: number } } };

  const x = viewport.value.w / 2;
  const y = viewport.value.h / 2;

  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: 0, deltaY,
  });

  return `Scrolled ${direction} by ${amount}px`;
}

// --- press_key ---

async function pressKey(tabId: number, key: string): Promise<string> {
  await sendCdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key, windowsVirtualKeyCode: key.charCodeAt(0),
  });
  await sendCdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, windowsVirtualKeyCode: key.charCodeAt(0),
  });
  return `Pressed ${key}`;
}

// --- page_url ---

async function pageUrl(tabId: number): Promise<{ url: string; title: string }> {
  const { result: urlResult } = await sendCdp(tabId, 'Runtime.evaluate', {
    expression: 'location.href', returnByValue: true,
  }) as { result: { value: string } };
  const { result: titleResult } = await sendCdp(tabId, 'Runtime.evaluate', {
    expression: 'document.title', returnByValue: true,
  }) as { result: { value: string } };
  return { url: urlResult.value, title: titleResult.value };
}

// --- select_text ---

async function selectText(tabId: number, selector: string): Promise<string> {
  const { result } = await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'Error: no element matches ' + ${JSON.stringify(selector)};
      return el.innerText || el.textContent || '';
    })()`,
    returnByValue: true,
  }) as { result: { value: string } };
  return result.value;
}

// --- page_screenshot ---

async function pageScreenshot(tabId: number): Promise<string> {
  const { data } = await sendCdp(tabId, 'Page.captureScreenshot', {
    format: 'png',
  }) as { data: string };
  return `data:image/png;base64,${data}`;
}

// --- evaluate_js ---

async function evaluateJs(tabId: number, expression: string): Promise<string> {
  const { result, exceptionDetails } = await sendCdp(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }) as { result: { value?: unknown; type?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

  if (exceptionDetails) {
    return `Error: ${exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'Unknown error'}`;
  }

  let value = result.value;
  if (typeof value === 'object') {
    value = JSON.stringify(value, null, 2);
  }
  const str = String(value ?? result.type ?? 'undefined');
  if (str.length > 50000) {
    return str.slice(0, 50000) + '\n[...truncated]';
  }
  return str;
}

// --- console_logs ---

function getConsoleLogs(tabId: number, args: { since?: number; level?: string }): ConsoleEntry[] {
  const buf = consoleBuffers.get(tabId) ?? [];
  let entries = buf;
  if (args.since) {
    entries = entries.filter(e => e.timestamp >= args.since!);
  }
  if (args.level) {
    entries = entries.filter(e => e.level === args.level);
  }
  return entries.slice(-50); // Return last 50
}

// --- network_requests ---

function getNetworkRequests(tabId: number, args: { since?: number; filter?: string }): NetworkEntry[] {
  const buf = networkBuffers.get(tabId) ?? [];
  let entries = buf;
  if (args.since) {
    entries = entries.filter(e => e.timestamp >= args.since!);
  }
  if (args.filter) {
    const pattern = args.filter.toLowerCase();
    entries = entries.filter(e => e.url.toLowerCase().includes(pattern));
  }
  return entries.slice(-50);
}

// --- cookies ---

async function getCookies(tabId: number): Promise<Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean }>> {
  const { cookies } = await sendCdp(tabId, 'Network.getCookies') as {
    cookies: Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean }>;
  };
  return cookies;
}

// --- tab management ---

function listTabs(): Promise<Array<{ id: number; title: string; url: string; active: boolean }>> {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      resolve(tabs.map(t => ({
        id: t.id!,
        title: t.title ?? '',
        url: t.url ?? '',
        active: t.active,
      })));
    });
  });
}

function switchTab(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { active: true }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function newTab(url: string): Promise<{ id: number }> {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) reject(new Error(chrome.runtime.lastError?.message ?? 'Failed to create tab'));
      else resolve({ id: tab.id });
    });
  });
}

function closeTab(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

// --- hover ---

async function hover(tabId: number, ref: string): Promise<string> {
  const pos = await resolveRef(tabId, ref);
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: pos.x, y: pos.y,
  });
  return `Hovered over element [ref=${ref}] at (${Math.round(pos.x)}, ${Math.round(pos.y)})`;
}

// --- drag ---

async function drag(tabId: number, fromRef: string, toRef: string): Promise<string> {
  const from = await resolveRef(tabId, fromRef);
  const to = await resolveRef(tabId, toRef);

  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1,
  });
  // Move in steps for smoother drag
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + (to.x - from.x) * (i / steps);
    const y = from.y + (to.y - from.y) * (i / steps);
    await sendCdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    await new Promise(r => setTimeout(r, 20));
  }
  await sendCdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1,
  });

  return `Dragged from [ref=${fromRef}] to [ref=${toRef}]`;
}

// ─── Message Router ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'tool_call') return false;

  handleToolCall(msg).then(
    (result) => sendResponse({ type: 'tool_response', id: msg.id, result }),
    (err) => sendResponse({ type: 'tool_response', id: msg.id, error: err.message })
  );

  return true; // async response
});

async function handleToolCall(msg: { id: string; tool: string; args: Record<string, unknown> }): Promise<unknown> {
  const { tool, args } = msg;

  // Tab management tools don't need a tab context
  if (tool === 'list_tabs') return listTabs();
  if (tool === 'switch_tab') return switchTab(args.tabId as number);
  if (tool === 'new_tab') return newTab(args.url as string);
  if (tool === 'close_tab') return closeTab(args.tabId as number);

  // All other tools need an active tab
  const tabId = await getActiveTabId();
  await ensureAttached(tabId);

  switch (tool) {
    case 'page_snapshot': return pageSnapshot(tabId);
    case 'click': return clickElement(tabId, args.ref as string);
    case 'type': return typeText(tabId, args.ref as string, args.text as string);
    case 'navigate': return navigate(tabId, args.url as string);
    case 'scroll': return scrollPage(tabId, args.direction as string, (args.amount as number) ?? 500);
    case 'press_key': return pressKey(tabId, args.key as string);
    case 'page_url': return pageUrl(tabId);
    case 'select_text': return selectText(tabId, args.selector as string);
    case 'page_screenshot': return pageScreenshot(tabId);
    case 'evaluate_js': return evaluateJs(tabId, args.expression as string);
    case 'console_logs': return getConsoleLogs(tabId, { since: args.since as number | undefined, level: args.level as string | undefined });
    case 'network_requests': return getNetworkRequests(tabId, { since: args.since as number | undefined, filter: args.filter as string | undefined });
    case 'cookies': return getCookies(tabId);
    case 'hover': return hover(tabId, args.ref as string);
    case 'drag': return drag(tabId, args.fromRef as string, args.toRef as string);
    default: throw new Error(`Unknown tool: ${tool}`);
  }
}
