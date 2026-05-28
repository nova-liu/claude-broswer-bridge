// Content script — page reading & actions
// Listens for messages from background script, executes DOM operations

interface InteractiveElement {
  index: number;
  tag: string;
  role: string;
  text: string;
  type?: string;
  href?: string;
}

let indexedElements: Element[] = [];

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;
  if (el.getAttribute('role') === 'button') return true;
  if (el.hasAttribute('onclick')) return true;
  if ((el as HTMLElement).tabIndex >= 0 && tag !== 'body') return true;
  return false;
}

function pageSnapshot(): string {
  indexedElements = [];
  const lines: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);

  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text && text.length > 0) {
        lines.push(text);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (!isVisible(el)) continue;
      if (isInteractive(el)) {
        const idx = indexedElements.length;
        indexedElements.push(el);
        const tag = el.tagName.toLowerCase();
        const text = (el as HTMLElement).innerText?.slice(0, 80) || el.getAttribute('aria-label') || '';
        const href = el.getAttribute('href') || '';
        const type = el.getAttribute('type') || '';
        let desc = `[${idx}] <${tag}`;
        if (type) desc += ` type="${type}"`;
        if (href) desc += ` href="${href}"`;
        desc += `> ${text}`;
        lines.push(desc);
      }
    }
  }

  // Truncate at ~100KB
  let result = '';
  for (const line of lines) {
    if (result.length + line.length > 100000) {
      result += '\n[...truncated]';
      break;
    }
    result += line + '\n';
  }
  return result;
}

function pageUrl(): { url: string; title: string } {
  return { url: location.href, title: document.title };
}

function selectText(selector: string): string {
  const el = document.querySelector(selector);
  if (!el) return `Error: no element matches "${selector}"`;
  return (el as HTMLElement).innerText || el.textContent || '';
}

function clickElement(index: number): string {
  const el = indexedElements[index] as HTMLElement | undefined;
  if (!el) return `Error: no element at index ${index}. Run page_snapshot first.`;
  if (!document.body.contains(el)) return `Error: element ${index} is stale. Run page_snapshot again.`;
  el.click();
  return `Clicked element ${index}: <${el.tagName.toLowerCase()}> ${el.innerText?.slice(0, 50) || ''}`;
}

function typeText(index: number, text: string): string {
  const el = indexedElements[index] as HTMLInputElement | HTMLTextAreaElement | undefined;
  if (!el) return `Error: no element at index ${index}`;
  if (!document.body.contains(el)) return `Error: element ${index} is stale`;

  el.focus();
  // React-compatible value setting
  const nativeSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el), 'value'
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return `Typed "${text}" into element ${index}`;
}

function scroll(direction: string, amount: number): string {
  const y = direction === 'up' ? -amount : amount;
  window.scrollBy(0, y);
  return `Scrolled ${direction} by ${amount}px. Now at y=${window.scrollY}`;
}

function navigate(url: string): string {
  window.location.href = url;
  return `Navigating to ${url}`;
}

function pressKey(key: string): string {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  return `Pressed ${key}`;
}

// Message listener
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'tool_call') return false;

  let result: unknown;
  try {
    switch (msg.tool) {
      case 'page_snapshot': result = pageSnapshot(); break;
      case 'page_url': result = pageUrl(); break;
      case 'select_text': result = selectText(msg.args.selector); break;
      case 'click_element': result = clickElement(msg.args.index); break;
      case 'type_text': result = typeText(msg.args.index, msg.args.text); break;
      case 'scroll': result = scroll(msg.args.direction, msg.args.amount); break;
      case 'navigate': result = navigate(msg.args.url); break;
      case 'press_key': result = pressKey(msg.args.key); break;
      default: result = `Error: unknown tool ${msg.tool}`;
    }
  } catch (e) {
    result = `Error: ${(e as Error).message}`;
  }

  sendResponse({ id: msg.id, result });
  return true; // async response
});
