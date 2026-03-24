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
let adminId = null;
let roomMarkerID = null;
let roomMarkerCornersWorld = null;
let roomMarkerCornersLocal = null;
let roomMarkerSizeMeters = null;

function broadcast(msg, except = null) {
  const raw = JSON.stringify(msg);
  for (const [id, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN && id !== except) ws.send(raw);
  }
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function logActiveUsers() {
  const ids = Array.from(clients.keys());
  const time = formatTime();
  console.log(`[${time}] active users ${ids.length}: [${ids.join(", ")}]`);
}

wss.on("connection", (ws) => {
  const id = `user-${randomUUID().slice(0, 8)}`;
  clients.set(id, ws);
  // membership changed -> compact summary log
  logActiveUsers();

  // If no admin yet, make the first connected client the admin
  if (!adminId) {
    adminId = id;
    // announce admin to anyone already connected
    console.log(`[Room] admin assigned to ${adminId}`);
    broadcast({ t: "admin_changed", adminId });
  }

  try {
    ws.send(JSON.stringify({ t: "welcome", clientId: id, adminId }));
  } catch (e) {}

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.warn("invalid json");
      return;
    }
    // Intentionally not logging every incoming message here to reduce noise.
    // Keep specific event logs only where useful (e.g. model updates).

    if (msg.t === "hello") {
      // don't log hello messages to avoid chatter
      if (msg.markerID) {
        if (!roomMarkerID) {
          roomMarkerID = msg.markerID;
        } else if (roomMarkerID !== msg.markerID) {
          console.warn(
            `[Room] marker mismatch: expected ${roomMarkerID}, received ${msg.markerID}`,
          );
        }
      }
      if (
        modelState &&
        msg.markerID &&
        (!roomMarkerID || roomMarkerID === msg.markerID)
      )
        ws.send(
          JSON.stringify({ t: "model_state", state: modelState, adminId }),
        );
    } else if (msg.t === "grab_request") {
      // don't log grab_request to avoid chatter; behavior unchanged
      // grant immediately for simplicity if no owner
      if (!currentOwner) {
        currentOwner = id;
        broadcast({ t: "grab_granted", ownerID: currentOwner });
      } else {
        // deny by ignoring; could implement queue
        // denied - intentionally no noisy log
      }
    } else if (msg.t === "grab_released") {
      // don't log grab_released events
      if (currentOwner === id) {
        currentOwner = null;
        broadcast({ t: "grab_released", clientId: id });
      }
    } else if (msg.t === "model_update") {
      console.log(`[Room] model_update from ${id} owner=${currentOwner}`);
      // update authoritative state and broadcast to others
      // If this update includes marker corner info, only accept it if we
      // haven't already recorded marker corners for this room (first scanner).
      if (
        msg.state &&
        msg.state.markerCornersWorld &&
        !roomMarkerCornersWorld
      ) {
        roomMarkerCornersWorld = msg.state.markerCornersWorld;
        roomMarkerCornersLocal = msg.state.markerCornersLocal || null;
        roomMarkerSizeMeters = msg.state.markerSizeMeters || null;
        console.log(`[Room] stored marker corners from ${id}`);
      }

      modelState = msg.state;
      modelState.ownerID = msg.state.ownerID;
      modelState.isLocked = true;
      if (msg.state.markerID) {
        roomMarkerID = msg.state.markerID;
      }
      broadcast({ t: "model_state", state: modelState, adminId }, msg.clientId);
      // write debug JSON so you can inspect model state in realtime
      try {
        await fs.writeFile(
          new URL("./model_state.json", import.meta.url),
          JSON.stringify(
            {
              modelState,
              roomMarker: {
                markerID: roomMarkerID,
                cornersWorld: roomMarkerCornersWorld,
                cornersLocal: roomMarkerCornersLocal,
                markerSizeMeters: roomMarkerSizeMeters,
              },
              lastUpdated: Date.now(),
            },
            null,
            2,
          ),
        );
      } catch (e) {
        // ignore file errors
      }
    } else if (msg.t === "get_state") {
      // client explicitly requests current model state
      if (modelState) {
        try {
          ws.send(
            JSON.stringify({ t: "model_state", state: modelState, adminId }),
          );
        } catch (e) {}
      }
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    // membership changed -> compact summary log
    logActiveUsers();
    if (currentOwner === id) {
      currentOwner = null;
      broadcast({ t: "grab_released", clientId: id });
    }
    // If admin disconnected, promote next connected client (if any)
    if (adminId === id) {
      const next = clients.keys().next();
      adminId = next.done ? null : next.value;
      broadcast({ t: "admin_changed", adminId });
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
