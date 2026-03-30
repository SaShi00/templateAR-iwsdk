import { WebSocketServer } from "ws";
import fs from "fs/promises";
import http from "http";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 8787;
const wss = new WebSocketServer({ port: PORT });

console.log(`room server listening on ws://localhost:${PORT}`);

// Simple in-memory room state
const clients = new Map();
const objectStates = new Map();
const objectOwners = new Map();
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
      if (msg.objectId && objectStates.has(msg.objectId)) {
        ws.send(
          JSON.stringify({
            t: "model_state",
            state: objectStates.get(msg.objectId),
            adminId,
          }),
        );
      }
    } else if (msg.t === "grab_request") {
      // don't log grab_request to avoid chatter; behavior unchanged
      // grant immediately for simplicity if no owner
      if (!msg.objectId) {
        return;
      }
      if (!objectOwners.has(msg.objectId)) {
        objectOwners.set(msg.objectId, id);
        broadcast({ t: "grab_granted", objectId: msg.objectId, ownerID: id });
      } else {
        // deny by ignoring; could implement queue
        // denied - intentionally no noisy log
      }
    } else if (msg.t === "grab_released") {
      // don't log grab_released events
      if (msg.objectId && objectOwners.get(msg.objectId) === id) {
        objectOwners.delete(msg.objectId);
        broadcast({ t: "grab_released", objectId: msg.objectId, clientId: id });
      }
    } else if (msg.t === "model_update") {
      const objectId = msg.state && msg.state.id ? msg.state.id : null;
      console.log(
        `[Room] model_update from ${id} object=${objectId || "unknown"}`,
      );
      if (!objectId) {
        return;
      }
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

      objectStates.set(objectId, msg.state);
      const state = objectStates.get(objectId);
      state.ownerID = msg.state.ownerID;
      state.isLocked = true;
      if (msg.state.markerID) {
        roomMarkerID = msg.state.markerID;
      }
      broadcast({ t: "model_state", state, adminId }, msg.clientId);
      // write debug JSON so you can inspect model state in realtime
      try {
        await fs.writeFile(
          new URL("./model_state.json", import.meta.url),
          JSON.stringify(
            {
              modelState: objectStates.get("model-1") || null,
              arrowState: objectStates.get("arrow-1") || null,
              objectStates: Object.fromEntries(objectStates.entries()),
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
      if (msg.objectId && objectStates.has(msg.objectId)) {
        try {
          ws.send(
            JSON.stringify({
              t: "model_state",
              state: objectStates.get(msg.objectId),
              adminId,
            }),
          );
        } catch (e) {}
      }
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    // membership changed -> compact summary log
    logActiveUsers();
    for (const [objectId, owner] of objectOwners.entries()) {
      if (owner === id) {
        objectOwners.delete(objectId);
        broadcast({ t: "grab_released", objectId, clientId: id });
      }
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
    res.end(
      JSON.stringify({
        modelState: objectStates.get("model-1") || null,
        arrowState: objectStates.get("arrow-1") || null,
        objectStates: Object.fromEntries(objectStates.entries()),
        lastUpdated: Date.now(),
      }),
    );
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
