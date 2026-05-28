The MCP browser tools are configured in bridge.mcp.json. If tools are not available, load that config first.

Use the page_snapshot MCP tool first to get the accessibility tree with element refs. Then use the hover tool to hover over the element the user specified (by description or ref). This will trigger any hover menus or tooltips. Run page_snapshot again to show what appeared.
