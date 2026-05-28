The MCP browser tools are configured in bridge.mcp.json. If tools are not available, load that config first.

Use the page_snapshot MCP tool first to get the accessibility tree with element refs. Then use the click tool to click the element the user specified (by description or ref). Confirm what was clicked and show any resulting page change by running page_snapshot again.
