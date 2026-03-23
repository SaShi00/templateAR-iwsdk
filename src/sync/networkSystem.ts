import { createSystem, Quaternion, Vector3 } from "@iwsdk/core";

type ModelState = {
  id: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: number;
  isLocked: boolean;
  ownerID?: string | null;
  timestamp: number;
};

type ServerMessage =
  | { t: "welcome"; clientId: string }
  | { t: "model_state"; state: ModelState }
  | { t: "grab_granted"; ownerID: string }
  | { t: "grab_released"; clientId: string }
  | {
      t: "anchor_created";
      anchorID: string;
      pos: [number, number, number];
      rot: [number, number, number, number];
    };

type ClientMessage =
  | { t: "hello"; clientId: string }
  | { t: "grab_request"; clientId: string }
  | { t: "grab_released"; clientId: string }
  | { t: "model_update"; clientId: string; state: ModelState };

export function makeNetworkSyncSystem(
  modelEntity: any,
  modelMesh: any,
  opts: any = {},
) {
  const serverPath = opts.serverPath || "/room";
  const serverUrl =
    opts.serverUrl ||
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${serverPath}`;
  const sendInterval = opts.sendInterval || 100;
  const releaseTimeout = opts.releaseTimeout || 500;

  return class NetworkSyncSystem extends createSystem({}, {}) {
    private socket: WebSocket | null = null;
    private debugEl: HTMLPreElement | null = null;
    private debugState: Record<string, unknown> = {};
    private lastDebugUpdate = 0;
    private clientId: string | null = null;
    private ownerID: string | null = null;
    private isOwner = false;
    private isLocked = false;
    private lastSend = 0;
    private lastMoveTime = 0;
    private lastPosition = new Vector3();
    private lastQuaternion = new Quaternion();
    private lastScale = 1;
    private applyingRemoteState = false;

    private makeFallbackClientId() {
      return `client-${Math.random().toString(36).slice(2, 10)}`;
    }

    init() {
      this.lastPosition.copy(modelMesh.position);
      this.lastQuaternion.copy(modelMesh.quaternion);
      this.lastScale = modelMesh.scale.x;

      this.socket = new WebSocket(serverUrl);
      this.socket.addEventListener("open", () => {
        console.log("[Network] connecting to room", serverUrl);
        this.send({ t: "hello", clientId: this.clientId || "pending" });
      });

      this.socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data) as ServerMessage;
          this.handleMessage(data);
        } catch (error) {
          console.warn("[Network] malformed message", error);
        }
      });

      this.socket.addEventListener("close", () => {
        console.log("[Network] disconnected");
      });

      this.createDebugOverlay();
      this.updateDebug(true);
    }

    createDebugOverlay() {
      try {
        this.debugEl = document.createElement("pre");
        this.debugEl.id = "multiplayer-debug";
        Object.assign(this.debugEl.style, {
          position: "fixed",
          right: "8px",
          bottom: "8px",
          width: "340px",
          maxHeight: "45vh",
          overflow: "auto",
          background: "rgba(0,0,0,0.72)",
          color: "#66ff99",
          fontFamily: "monospace",
          fontSize: "12px",
          lineHeight: "1.35",
          padding: "8px",
          border: "1px solid rgba(102, 255, 153, 0.35)",
          borderRadius: "6px",
          zIndex: "99999",
          whiteSpace: "pre-wrap",
          pointerEvents: "none",
        });
        this.debugEl.textContent = "waiting for network...";
        document.body.appendChild(this.debugEl);
      } catch {
        this.debugEl = null;
      }
    }

    send(message: ClientMessage) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify(message));
    }

    handleMessage(message: ServerMessage) {
      if (message.t === "welcome") {
        this.clientId =
          typeof message.clientId === "string" && message.clientId.trim()
            ? message.clientId
            : this.makeFallbackClientId();
        console.log("[Network] joined as", this.clientId);
        this.debugState = { ...this.debugState, joinedAs: this.clientId };
        this.updateDebug(true);
        return;
      }

      if (!this.clientId) {
        return;
      }

      if (message.t === "model_state") {
        const state = message.state;
        if (state.ownerID === this.clientId && this.isOwner) {
          return;
        }

        this.ownerID = state.ownerID || null;
        this.isLocked = Boolean(state.isLocked);
        this.applyRemoteState(state);
        this.debugState = { ...this.debugState, incoming: state };
        this.updateDebug();
        return;
      }

      if (message.t === "grab_granted") {
        this.ownerID = message.ownerID;
        this.isOwner = message.ownerID === this.clientId;
        this.isLocked = true;
        console.log(`[Network] grab granted to ${message.ownerID}`);
        this.debugState = { ...this.debugState, grabGranted: message.ownerID };
        this.updateDebug(true);
        return;
      }

      if (message.t === "grab_released") {
        this.isOwner = false;
        this.isLocked = false;
        this.ownerID = null;
        console.log(`[Network] grab released by ${message.clientId}`);
        this.debugState = {
          ...this.debugState,
          grabReleased: message.clientId,
        };
        this.updateDebug(true);
        return;
      }

      if (message.t === "anchor_created") {
        this.debugState = { ...this.debugState, anchor: message.anchorID };
        this.updateDebug(true);
      }
    }

    applyRemoteState(state: ModelState) {
      this.applyingRemoteState = true;
      modelMesh.position.set(state.pos[0], state.pos[1], state.pos[2]);
      modelMesh.quaternion.set(
        state.rot[0],
        state.rot[1],
        state.rot[2],
        state.rot[3],
      );
      modelMesh.scale.setScalar(state.scale);
      this.lastPosition.copy(modelMesh.position);
      this.lastQuaternion.copy(modelMesh.quaternion);
      this.lastScale = modelMesh.scale.x;
      this.applyingRemoteState = false;
    }

    updateDebug(force = false) {
      if (!this.debugEl) return;
      const now = performance.now();
      if (!force && now - this.lastDebugUpdate < 200) return;
      this.lastDebugUpdate = now;

      this.debugEl.textContent = JSON.stringify(
        {
          clientId: this.clientId,
          ownerID: this.ownerID,
          isOwner: this.isOwner,
          isLocked: this.isLocked,
          mesh: {
            position: [
              modelMesh.position.x,
              modelMesh.position.y,
              modelMesh.position.z,
            ],
            rotation: [
              modelMesh.quaternion.x,
              modelMesh.quaternion.y,
              modelMesh.quaternion.z,
              modelMesh.quaternion.w,
            ],
            scale: modelMesh.scale.x,
          },
          debugState: this.debugState,
        },
        null,
        2,
      );
    }

    update() {
      if (!this.clientId) {
        this.updateDebug();
        return;
      }

      const now = performance.now();
      const moved =
        !modelMesh.position.equals(this.lastPosition) ||
        !modelMesh.quaternion.equals(this.lastQuaternion) ||
        modelMesh.scale.x !== this.lastScale;

      if (moved && !this.applyingRemoteState) {
        this.lastMoveTime = now;
      }

      if (
        moved &&
        !this.isOwner &&
        !this.isLocked &&
        !this.applyingRemoteState
      ) {
        this.send({ t: "grab_request", clientId: this.clientId });
      }

      if (this.isOwner && now - this.lastSend >= sendInterval) {
        const state: ModelState = {
          id: "model-1",
          pos: [
            modelMesh.position.x,
            modelMesh.position.y,
            modelMesh.position.z,
          ],
          rot: [
            modelMesh.quaternion.x,
            modelMesh.quaternion.y,
            modelMesh.quaternion.z,
            modelMesh.quaternion.w,
          ],
          scale: modelMesh.scale.x,
          isLocked: true,
          ownerID: this.clientId,
          timestamp: Date.now(),
        };

        this.send({ t: "model_update", clientId: this.clientId, state });
        this.lastSend = now;
      }

      if (this.isOwner && now - this.lastMoveTime > releaseTimeout) {
        this.send({ t: "grab_released", clientId: this.clientId });
        this.isOwner = false;
        this.isLocked = false;
        this.ownerID = null;
      }

      this.lastPosition.copy(modelMesh.position);
      this.lastQuaternion.copy(modelMesh.quaternion);
      this.lastScale = modelMesh.scale.x;
      this.updateDebug();
    }

    dispose() {
      this.socket?.close();
    }
  };
}

export type { ModelState };
