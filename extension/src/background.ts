// Background service worker
// Routes tool calls between side panel (WebSocket) and content scripts (tabs)

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for tool calls forwarded from the side panel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'tool_call') return false;

  // Route to active tab's content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) {
      // Send error response back to side panel
      chrome.runtime.sendMessage({
        type: 'tool_response',
        id: msg.id,
        error: 'No active tab available',
      });
      return;
    }

    // Check if we can access this tab
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
      chrome.runtime.sendMessage({
        type: 'tool_response',
        id: msg.id,
        error: `Cannot access restricted page: ${tab.url}`,
      });
      return;
    }

    chrome.tabs.sendMessage(tab.id, msg, (response) => {
      if (chrome.runtime.lastError) {
        chrome.runtime.sendMessage({
          type: 'tool_response',
          id: msg.id,
          error: `Content script error: ${chrome.runtime.lastError.message}`,
        });
        return;
      }
      // Forward response back to side panel → WebSocket → bridge
      chrome.runtime.sendMessage({
        type: 'tool_response',
        id: response.id,
        result: response.result,
      });
    });
  });

  return true;
});
