import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3001/ws");

ws.on("open", () => {
  console.log("WS connected, sending test chat...");
  ws.send(
    JSON.stringify({
      type: "chat",
      payload: {
        message: "Search the web for the latest updates on AI coding agents with Tavily and summarize in 2 sentences.",
        model: "devstral",
      },
    })
  );
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  console.log(`[WS Event: ${msg.type}]`, msg.payload?.name || msg.payload?.content?.slice(0, 100) || msg.payload?.message || "");
  if (msg.type === "done" || msg.type === "error") {
    ws.close();
    process.exit(0);
  }
});
