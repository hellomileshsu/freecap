#!/usr/bin/env node
import { startBridge, startMcpServer } from "./server.mjs";

const command = process.argv[2] || "mcp";

if (command === "bridge") {
  startBridge();
  process.stdin.resume();
} else if (command === "setup") {
  console.log("FreeCap MCP setup");
  console.log("\nClaude Code / Codex:");
  console.log("npx -y github:hellomileshsu/freecap#v1.2 mcp");
  console.log("\nCursor mcp.json:");
  console.log(JSON.stringify({ mcpServers: { freecap: { command: "npx", args: ["-y", "github:hellomileshsu/freecap#v1.2", "mcp"] } } }, null, 2));
  console.log("\nSupported tools: start_transcription, get_job, update_cues, export_subtitles, start_render, cancel_job");
} else {
  await startMcpServer();
}
