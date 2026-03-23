import { WebSocketServer } from "ws";
import fs from "fs/promises";
import http from "http";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 8787;
const wss = new WebSocketServer({ port: PORT });

console.log(`room server listening on ws://localhost:${PORT}`);

// Simple in-memory room state
const clients = new Map();
let modelState = null;
let currentOwner = null;
let anchor = null;

function broadcast(msg, except = null) {
  const raw = JSON.stringify(msg);
  for (const [id, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN && id !== except) ws.send(raw);
  }
}

wss.on("connection", (ws) => {
  const id = `user-${randomUUID().slice(0, 8)}`;
  clients.set(id, ws);
  console.log(`[Room] user joined ${id}`);

  try {
    ws.send(JSON.stringify({ t: "welcome", clientId: id }));
  } catch (e) {}

  // Immediately send current state (helpful for new joiners)
  if (modelState) {
    try {
      ws.send(JSON.stringify({ t: "model_state", state: modelState }));
    } catch (e) {}
  }
  if (anchor) {
    try {
      ws.send(
        JSON.stringify({
          t: "anchor_created",
          anchorID: anchor.id,
          pos: anchor.pos,
          rot: anchor.rot,
        }),
      );
    } catch (e) {}
  }

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.warn("invalid json");
      return;
    }
    console.log(
      `[Room] message ${msg.t || "unknown"} from ${msg.clientId || id}`,
    );

    if (msg.t === "hello") {
      console.log(`[Room] hello from ${id}`);
      // send current modelState and anchor
      if (modelState)
        ws.send(JSON.stringify({ t: "model_state", state: modelState }));
      if (anchor)
        ws.send(
          JSON.stringify({
            t: "anchor_created",
            anchorID: anchor.id,
            pos: anchor.pos,
            rot: anchor.rot,
          }),
        );
    } else if (msg.t === "create_anchor") {
      anchor = {
        id: msg.anchorID,
        pos: msg.pos,
        rot: msg.rot,
        clientId: msg.clientId,
      };
      broadcast({
        t: "anchor_created",
        anchorID: anchor.id,
        pos: anchor.pos,
        rot: anchor.rot,
      });
    } else if (msg.t === "grab_request") {
      console.log(`[Room] grab_request from ${id}`);
      // grant immediately for simplicity if no owner
      if (!currentOwner) {
        currentOwner = id;
        broadcast({ t: "grab_granted", ownerID: currentOwner });
        console.log(`[Room] grab granted to ${currentOwner}`);
      } else {
        // deny by ignoring; could implement queue
        console.log(
          `[Room] grab_request denied for ${id} (owner ${currentOwner})`,
        );
      }
    } else if (msg.t === "grab_released") {
      console.log(`[Room] grab_released from ${id}`);
      if (currentOwner === id) {
        currentOwner = null;
        broadcast({ t: "grab_released", clientId: id });
      }
    } else if (msg.t === "model_update") {
      console.log(`[Room] model_update from ${id} owner=${currentOwner}`);
      // update authoritative state and broadcast to others
      modelState = msg.state;
      modelState.ownerID = msg.state.ownerID;
      modelState.isLocked = true;
      broadcast({ t: "model_state", state: modelState }, msg.clientId);
      // write debug JSON so you can inspect model state in realtime
      try {
        await fs.writeFile(
          new URL("./model_state.json", import.meta.url),
          JSON.stringify({ modelState, lastUpdated: Date.now() }, null, 2),
        );
      } catch (e) {
        // ignore file errors
      }
    } else if (msg.t === "get_state") {
      // client explicitly requests current model state
      if (modelState) {
        try {
          ws.send(JSON.stringify({ t: "model_state", state: modelState }));
        } catch (e) {}
      }
    }
  });

  ws.on("close", () => {
    console.log(`[Room] user left ${id}`);
    clients.delete(id);
    if (currentOwner === id) {
      currentOwner = null;
      broadcast({ t: "grab_released", clientId: id });
    }
  });
});

// Small HTTP endpoint for viewing current model state in the browser
const httpPort = process.env.HTTP_PORT || 8788;
const httpServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/model_state.json") {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ modelState, lastUpdated: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.listen(httpPort, () => {
  console.log(
    `debug HTTP server listening on http://localhost:${httpPort}/model_state.json`,
  );
});
