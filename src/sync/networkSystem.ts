import {
  createSystem,
  CameraSource,
  CameraUtils,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
  DistanceGrabbable,
  MovementMode,
} from "@iwsdk/core";
import jsQR from "jsqr";

type ModelState = {
  id: string;
  markerID?: string | null;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: number;
  isLocked: boolean;
  ownerID?: string | null;
  timestamp: number;
  markerCornersWorld?: [number, number, number][];
  markerCornersLocal?: [number, number, number][];
  markerSizeMeters?: number;
  modelMarkerPosLocal?: [number, number, number];
  modelMarkerRotLocal?: [number, number, number, number];
};

type AnchorState = {
  markerID: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
  clientId: string;
  timestamp: number;
};

type QRScanSample = {
  markerID: string;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  pixelWidth: number;
  pixelHeight: number;
  topLeft?: { x: number; y: number };
  topRight?: { x: number; y: number };
  bottomLeft?: { x: number; y: number };
  bottomRight?: { x: number; y: number };
};

type MarkerPoseEstimate = {
  matrix: Matrix4;
  position: Vector3;
  quaternion: Quaternion;
};

type ServerMessage =
  | { t: "welcome"; clientId: string }
  | { t: "model_state"; state: ModelState }
  | { t: "grab_granted"; ownerID: string }
  | { t: "grab_released"; clientId: string };

type ClientMessage =
  | { t: "hello"; clientId: string; markerID?: string | null }
  | { t: "grab_request"; clientId: string }
  | { t: "grab_released"; clientId: string }
  | { t: "model_update"; clientId: string; state: ModelState }
  | { t: "get_state"; clientId: string };

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
    private modelEntity: any = null;
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
    private cameraEntity: any = null;
    private markerID: string | null = null;
    private lastMarkerScan = 0;
    private markerScanInterval = 250;
    private markerHelloSent = false;
    private sharedModelStateReceived = false;
    private pendingInitialPlacement: QRScanSample | null = null;
    private initialPlacementTimer: number | null = null;
    private initialPlacementPublished = false;
    private currentMarkerPose: MarkerPoseEstimate | null = null;
    private markerPhysicalSizeMeters = opts.markerPhysicalSizeMeters || 0.145;
    private cameraHorizontalFovDeg = opts.cameraHorizontalFovDeg || 63;
    private markerHoverMeters = opts.markerHoverMeters || 0.03;
    private initialMarkerOffsetMeters = opts.initialMarkerOffsetMeters || 0.15;
    // Jitter suppression thresholds
    private positionEpsilon = opts.positionEpsilon || 0.01; // meters
    private rotationEpsilon = opts.rotationEpsilon || 0.02; // radians (~1.1 deg)
    private scaleEpsilon = opts.scaleEpsilon || 0.005; // relative
    private enableSmoothing =
      opts.enableSmoothing !== undefined ? opts.enableSmoothing : true;
    private smoothingFactor = opts.smoothingFactor || 0.25;

    private makeFallbackClientId() {
      return `client-${Math.random().toString(36).slice(2, 10)}`;
    }

    init() {
      // If the caller provided an entity (created at startup), use it so
      // the grabbing component is already registered with the world.
      if (modelEntity) this.modelEntity = modelEntity;
      this.lastPosition.copy(modelMesh.position);
      this.lastQuaternion.copy(modelMesh.quaternion);
      this.lastScale = modelMesh.scale.x;

      this.createCameraProbe();

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

    createCameraProbe() {
      if (this.cameraEntity) {
        return;
      }

      const cameraObject = new Object3D();
      cameraObject.visible = false;
      this.cameraEntity = this.world.createTransformEntity(cameraObject);
      this.cameraEntity.addComponent(CameraSource, {
        facing: "back",
        width: 1280,
        height: 720,
        frameRate: 15,
      });
    }

    scanMarker(now: number) {
      if (
        !this.cameraEntity ||
        now - this.lastMarkerScan < this.markerScanInterval
      ) {
        return;
      }

      this.lastMarkerScan = now;
      const canvas = CameraUtils.captureFrame(this.cameraEntity);
      if (!canvas) {
        return;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        return;
      }

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const qrCode = jsQR(imageData.data, canvas.width, canvas.height, {
        inversionAttempts: "dontInvert",
      });

      if (!qrCode?.data) {
        return;
      }

      const scannedMarkerID = qrCode.data.trim();
      if (!scannedMarkerID || scannedMarkerID === this.markerID) {
        return;
      }

      const location = qrCode.location;
      const topWidth = Math.hypot(
        location.topRightCorner.x - location.topLeftCorner.x,
        location.topRightCorner.y - location.topLeftCorner.y,
      );
      const bottomWidth = Math.hypot(
        location.bottomRightCorner.x - location.bottomLeftCorner.x,
        location.bottomRightCorner.y - location.bottomLeftCorner.y,
      );
      const leftHeight = Math.hypot(
        location.bottomLeftCorner.x - location.topLeftCorner.x,
        location.bottomLeftCorner.y - location.topLeftCorner.y,
      );
      const rightHeight = Math.hypot(
        location.bottomRightCorner.x - location.topRightCorner.x,
        location.bottomRightCorner.y - location.topRightCorner.y,
      );

      this.pendingInitialPlacement = {
        markerID: scannedMarkerID,
        width: canvas.width,
        height: canvas.height,
        centerX:
          (location.topLeftCorner.x +
            location.topRightCorner.x +
            location.bottomRightCorner.x +
            location.bottomLeftCorner.x) /
          4,
        centerY:
          (location.topLeftCorner.y +
            location.topRightCorner.y +
            location.bottomRightCorner.y +
            location.bottomLeftCorner.y) /
          4,
        pixelWidth: (topWidth + bottomWidth) / 2,
        pixelHeight: (leftHeight + rightHeight) / 2,
        topLeft: { x: location.topLeftCorner.x, y: location.topLeftCorner.y },
        topRight: {
          x: location.topRightCorner.x,
          y: location.topRightCorner.y,
        },
        bottomLeft: {
          x: location.bottomLeftCorner.x,
          y: location.bottomLeftCorner.y,
        },
        bottomRight: {
          x: location.bottomRightCorner.x,
          y: location.bottomRightCorner.y,
        },
      };

      this.currentMarkerPose = this.solveMarkerPose(
        this.pendingInitialPlacement,
      );
      if (!this.currentMarkerPose) {
        return;
      }

      this.markerID = scannedMarkerID;
      this.debugState = { ...this.debugState, markerID: this.markerID };
      this.updateDebug(true);

      if (this.clientId && !this.markerHelloSent) {
        this.markerHelloSent = true;
        this.send({
          t: "hello",
          clientId: this.clientId,
          markerID: this.markerID,
        });
      }

      if (!this.sharedModelStateReceived && !this.initialPlacementTimer) {
        // Ask server for existing state (if any) to avoid racing and
        // possibly overwriting an existing canonical placement.
        try {
          this.send({ t: "get_state", clientId: this.clientId || "pending" });
        } catch {}

        // Wait a bit longer for the server to respond before publishing.
        this.initialPlacementTimer = window.setTimeout(() => {
          this.initialPlacementTimer = null;
          if (
            this.sharedModelStateReceived ||
            this.initialPlacementPublished ||
            !this.pendingInitialPlacement ||
            !this.clientId
          ) {
            return;
          }

          this.publishInitialPlacement(this.pendingInitialPlacement);
        }, 1000);
      }
    }

    publishInitialPlacement(sample: QRScanSample) {
      const markerMeasurement = this.estimateMarkerPlacement(sample);
      if (!markerMeasurement || !this.clientId) {
        return;
      }

      this.initialPlacementPublished = true;
      this.isOwner = true;
      this.isLocked = true;
      this.ownerID = this.clientId;
      this.applyRemoteState(markerMeasurement, true);
      this.debugState = {
        ...this.debugState,
        initialPlacement: markerMeasurement,
      };
      this.updateDebug(true);
      this.send({
        t: "model_update",
        clientId: this.clientId,
        state: this.withMarkerLocalPose(markerMeasurement),
      });
    }

    estimateMarkerCornersWorld(
      sample: QRScanSample,
    ): [number, number, number][] | null {
      const markerPose = this.solveMarkerPose(sample);
      if (!markerPose) {
        return null;
      }

      const markerSize = this.markerPhysicalSizeMeters;
      const localCorners = [
        new Vector3(0, 0, 0),
        new Vector3(markerSize, 0, 0),
        new Vector3(markerSize, markerSize, 0),
        new Vector3(0, markerSize, 0),
      ];

      return localCorners.map((corner) => {
        const worldCorner = corner.clone().applyMatrix4(markerPose.matrix);
        return [worldCorner.x, worldCorner.y, worldCorner.z];
      });
    }

    solveMarkerPose(sample: QRScanSample): MarkerPoseEstimate | null {
      const topLeft = sample.topLeft;
      const topRight = sample.topRight;
      const bottomRight = sample.bottomRight;
      const bottomLeft = sample.bottomLeft;

      if (!topLeft || !topRight || !bottomRight || !bottomLeft) {
        return null;
      }

      const fieldOfViewRad = (this.cameraHorizontalFovDeg * Math.PI) / 180;
      const focalLengthPx = sample.width / (2 * Math.tan(fieldOfViewRad / 2));
      const cx = sample.width / 2;
      const cy = sample.height / 2;
      const markerSize = this.markerPhysicalSizeMeters;

      const homography = this.solveHomography([
        { X: 0, Y: 0, u: topLeft.x, v: topLeft.y },
        { X: markerSize, Y: 0, u: topRight.x, v: topRight.y },
        { X: markerSize, Y: markerSize, u: bottomRight.x, v: bottomRight.y },
        { X: 0, Y: markerSize, u: bottomLeft.x, v: bottomLeft.y },
      ]);

      if (!homography) {
        return null;
      }

      const h00 = homography[0];
      const h01 = homography[1];
      const h02 = homography[2];
      const h10 = homography[3];
      const h11 = homography[4];
      const h12 = homography[5];
      const h20 = homography[6];
      const h21 = homography[7];
      const h22 = homography[8];

      const invFx = 1 / focalLengthPx;
      const invFy = 1 / focalLengthPx;
      const kInvH00 = invFx * h00 + -cx * invFx * h20;
      const kInvH01 = invFx * h01 + -cx * invFx * h21;
      const kInvH02 = invFx * h02 + -cx * invFx * h22;
      const kInvH10 = invFy * h10 + -cy * invFy * h20;
      const kInvH11 = invFy * h11 + -cy * invFy * h21;
      const kInvH12 = invFy * h12 + -cy * invFy * h22;
      const kInvH20 = h20;
      const kInvH21 = h21;
      const kInvH22 = h22;

      const norm1 = Math.hypot(kInvH00, kInvH10, kInvH20);
      const norm2 = Math.hypot(kInvH01, kInvH11, kInvH21);
      const scale = (norm1 + norm2) / 2 || 1;

      let r1x = kInvH00 / scale;
      let r1y = kInvH10 / scale;
      let r1z = kInvH20 / scale;
      let r2x = kInvH01 / scale;
      let r2y = kInvH11 / scale;
      let r2z = kInvH21 / scale;
      const tx = kInvH02 / scale;
      const ty = kInvH12 / scale;
      const tz = kInvH22 / scale;

      const r1Length = Math.hypot(r1x, r1y, r1z) || 1;
      r1x /= r1Length;
      r1y /= r1Length;
      r1z /= r1Length;

      const dot12 = r1x * r2x + r1y * r2y + r1z * r2z;
      r2x -= r1x * dot12;
      r2y -= r1y * dot12;
      r2z -= r1z * dot12;
      const r2Length = Math.hypot(r2x, r2y, r2z) || 1;
      r2x /= r2Length;
      r2y /= r2Length;
      r2z /= r2Length;

      const r3x = r1y * r2z - r1z * r2y;
      const r3y = r1z * r2x - r1x * r2z;
      const r3z = r1x * r2y - r1y * r2x;

      const markerMatrixCamera = new Matrix4().set(
        r1x,
        r2x,
        r3x,
        tx,
        r1y,
        r2y,
        r3y,
        ty,
        r1z,
        r2z,
        r3z,
        tz,
        0,
        0,
        0,
        1,
      );

      const markerMatrixThree = new Matrix4().set(
        markerMatrixCamera.elements[0],
        markerMatrixCamera.elements[4],
        markerMatrixCamera.elements[8],
        markerMatrixCamera.elements[12],
        -markerMatrixCamera.elements[1],
        -markerMatrixCamera.elements[5],
        -markerMatrixCamera.elements[9],
        -markerMatrixCamera.elements[13],
        -markerMatrixCamera.elements[2],
        -markerMatrixCamera.elements[6],
        -markerMatrixCamera.elements[10],
        -markerMatrixCamera.elements[14],
        0,
        0,
        0,
        1,
      );

      this.camera.updateMatrixWorld?.(true);
      const markerWorldMatrix = new Matrix4().multiplyMatrices(
        this.camera.matrixWorld,
        markerMatrixThree,
      );

      const position = new Vector3().setFromMatrixPosition(markerWorldMatrix);
      const quaternion = new Quaternion().setFromRotationMatrix(
        markerWorldMatrix,
      );

      return {
        matrix: markerWorldMatrix,
        position,
        quaternion,
      };
    }

    solveHomography(
      correspondences: Array<{ X: number; Y: number; u: number; v: number }>,
    ): number[] | null {
      const rows = [
        [
          correspondences[0].X,
          correspondences[0].Y,
          1,
          0,
          0,
          0,
          -correspondences[0].u * correspondences[0].X,
          -correspondences[0].u * correspondences[0].Y,
        ],
        [
          0,
          0,
          0,
          correspondences[0].X,
          correspondences[0].Y,
          1,
          -correspondences[0].v * correspondences[0].X,
          -correspondences[0].v * correspondences[0].Y,
        ],
        [
          correspondences[1].X,
          correspondences[1].Y,
          1,
          0,
          0,
          0,
          -correspondences[1].u * correspondences[1].X,
          -correspondences[1].u * correspondences[1].Y,
        ],
        [
          0,
          0,
          0,
          correspondences[1].X,
          correspondences[1].Y,
          1,
          -correspondences[1].v * correspondences[1].X,
          -correspondences[1].v * correspondences[1].Y,
        ],
        [
          correspondences[2].X,
          correspondences[2].Y,
          1,
          0,
          0,
          0,
          -correspondences[2].u * correspondences[2].X,
          -correspondences[2].u * correspondences[2].Y,
        ],
        [
          0,
          0,
          0,
          correspondences[2].X,
          correspondences[2].Y,
          1,
          -correspondences[2].v * correspondences[2].X,
          -correspondences[2].v * correspondences[2].Y,
        ],
        [
          correspondences[3].X,
          correspondences[3].Y,
          1,
          0,
          0,
          0,
          -correspondences[3].u * correspondences[3].X,
          -correspondences[3].u * correspondences[3].Y,
        ],
        [
          0,
          0,
          0,
          correspondences[3].X,
          correspondences[3].Y,
          1,
          -correspondences[3].v * correspondences[3].X,
          -correspondences[3].v * correspondences[3].Y,
        ],
      ];
      const vector = [
        correspondences[0].u,
        correspondences[0].v,
        correspondences[1].u,
        correspondences[1].v,
        correspondences[2].u,
        correspondences[2].v,
        correspondences[3].u,
        correspondences[3].v,
      ];

      const solution = this.solveGaussian(rows, vector);
      if (!solution) {
        return null;
      }

      return [
        solution[0],
        solution[1],
        solution[2],
        solution[3],
        solution[4],
        solution[5],
        solution[6],
        solution[7],
        1,
      ];
    }

    solveGaussian(matrix: number[][], vector: number[]): number[] | null {
      const size = vector.length;
      const augmented = matrix.map((row, index) => [...row, vector[index]]);

      for (let pivot = 0; pivot < size; pivot += 1) {
        let bestRow = pivot;
        for (let row = pivot + 1; row < size; row += 1) {
          if (
            Math.abs(augmented[row][pivot]) >
            Math.abs(augmented[bestRow][pivot])
          ) {
            bestRow = row;
          }
        }

        if (Math.abs(augmented[bestRow][pivot]) < 1e-8) {
          return null;
        }

        if (bestRow !== pivot) {
          const swap = augmented[pivot];
          augmented[pivot] = augmented[bestRow];
          augmented[bestRow] = swap;
        }

        const pivotValue = augmented[pivot][pivot];
        for (let column = pivot; column <= size; column += 1) {
          augmented[pivot][column] /= pivotValue;
        }

        for (let row = 0; row < size; row += 1) {
          if (row === pivot) continue;
          const factor = augmented[row][pivot];
          if (factor === 0) continue;
          for (let column = pivot; column <= size; column += 1) {
            augmented[row][column] -= factor * augmented[pivot][column];
          }
        }
      }

      return augmented.map((row) => row[size]);
    }

    withMarkerLocalPose(state: ModelState): ModelState {
      const markerPose = this.currentMarkerPose;
      if (!markerPose) {
        return state;
      }

      const worldMatrix = new Matrix4().compose(
        new Vector3(state.pos[0], state.pos[1], state.pos[2]),
        new Quaternion(state.rot[0], state.rot[1], state.rot[2], state.rot[3]),
        new Vector3(state.scale, state.scale, state.scale),
      );
      const markerInverse = new Matrix4().copy(markerPose.matrix).invert();
      const localMatrix = new Matrix4().multiplyMatrices(
        markerInverse,
        worldMatrix,
      );

      const localPosition = new Vector3();
      const localQuaternion = new Quaternion();
      const localScale = new Vector3();
      localMatrix.decompose(localPosition, localQuaternion, localScale);

      return {
        ...state,
        modelMarkerPosLocal: [
          localPosition.x,
          localPosition.y,
          localPosition.z,
        ],
        modelMarkerRotLocal: [
          localQuaternion.x,
          localQuaternion.y,
          localQuaternion.z,
          localQuaternion.w,
        ],
      };
    }

    resolveStateForLocalMarker(state: ModelState): ModelState {
      const markerPose = this.currentMarkerPose;
      if (!state.modelMarkerPosLocal || !markerPose) {
        return state;
      }

      const localPosition = new Vector3(
        state.modelMarkerPosLocal[0],
        state.modelMarkerPosLocal[1],
        state.modelMarkerPosLocal[2],
      );
      const localQuaternion = state.modelMarkerRotLocal
        ? new Quaternion(
            state.modelMarkerRotLocal[0],
            state.modelMarkerRotLocal[1],
            state.modelMarkerRotLocal[2],
            state.modelMarkerRotLocal[3],
          )
        : new Quaternion();
      const localScale = new Vector3(state.scale, state.scale, state.scale);
      const localMatrix = new Matrix4().compose(
        localPosition,
        localQuaternion,
        localScale,
      );
      const worldMatrix = new Matrix4().multiplyMatrices(
        markerPose.matrix,
        localMatrix,
      );

      const worldPosition = new Vector3();
      const worldQuaternion = new Quaternion();
      const worldScale = new Vector3();
      worldMatrix.decompose(worldPosition, worldQuaternion, worldScale);

      return {
        ...state,
        pos: [worldPosition.x, worldPosition.y, worldPosition.z],
        rot: [
          worldQuaternion.x,
          worldQuaternion.y,
          worldQuaternion.z,
          worldQuaternion.w,
        ],
        scale: worldScale.x,
      };
    }

    estimateMarkerPlacement(sample: QRScanSample): ModelState | null {
      const markerPose = this.currentMarkerPose || this.solveMarkerPose(sample);
      if (!markerPose) {
        return null;
      }

      const worldPosition = new Vector3(
        this.initialMarkerOffsetMeters,
        0,
        0,
      ).applyMatrix4(markerPose.matrix);
      const worldQuaternion = markerPose.quaternion.clone();

      const cornerWorlds = this.estimateMarkerCornersWorld(sample);
      if (!cornerWorlds) {
        return null;
      }

      const markerSize = this.markerPhysicalSizeMeters;
      const markerCornersLocal: [number, number, number][] = [
        [0, 0, 0],
        [markerSize, 0, 0],
        [markerSize, markerSize, 0],
        [0, markerSize, 0],
      ];

      return {
        id: "model-1",
        markerID: sample.markerID,
        pos: [worldPosition.x, worldPosition.y, worldPosition.z],
        rot: [
          worldQuaternion.x,
          worldQuaternion.y,
          worldQuaternion.z,
          worldQuaternion.w,
        ],
        scale: modelMesh.scale.x,
        isLocked: true,
        ownerID: this.clientId,
        timestamp: Date.now(),
        markerCornersWorld: cornerWorlds,
        markerCornersLocal: markerCornersLocal,
        markerSizeMeters: markerSize,
      };
    }

    handleMessage(message: ServerMessage) {
      if (message.t === "welcome") {
        this.clientId =
          typeof message.clientId === "string" && message.clientId.trim()
            ? message.clientId
            : this.makeFallbackClientId();
        this.debugState = { ...this.debugState, joinedAs: this.clientId };
        this.updateDebug(true);
        if (this.markerID) {
          this.markerHelloSent = true;
          this.send({
            t: "hello",
            clientId: this.clientId,
            markerID: this.markerID,
          });
        }
        return;
      }

      if (!this.clientId) {
        return;
      }

      if (message.t === "model_state") {
        const state = this.resolveStateForLocalMarker(message.state);
        this.sharedModelStateReceived = true;
        if (this.initialPlacementTimer) {
          window.clearTimeout(this.initialPlacementTimer);
          this.initialPlacementTimer = null;
        }
        if (
          state.markerID &&
          this.markerID &&
          state.markerID !== this.markerID
        ) {
          return;
        }
        if (state.ownerID === this.clientId && this.isOwner) {
          return;
        }

        this.ownerID = state.ownerID || null;
        this.isLocked = Boolean(state.isLocked);
        this.applyRemoteState(state, !modelMesh.visible);
        this.debugState = { ...this.debugState, incoming: state };
        this.updateDebug();
        return;
      }

      if (message.t === "grab_granted") {
        this.ownerID = message.ownerID;
        this.isOwner = message.ownerID === this.clientId;
        this.isLocked = true;
        this.debugState = { ...this.debugState, grabGranted: message.ownerID };
        this.updateDebug(true);
        return;
      }

      if (message.t === "grab_released") {
        this.isOwner = false;
        this.isLocked = false;
        this.ownerID = null;
        this.debugState = {
          ...this.debugState,
          grabReleased: message.clientId,
        };
        this.updateDebug(true);
        return;
      }
    }

    applyRemoteState(state: ModelState, preserveRotation = false) {
      this.applyingRemoteState = true;
      // Ensure the mesh is visible and attached to the world as an entity
      if (!modelMesh.visible) modelMesh.visible = true;
      if (!this.modelEntity) {
        this.modelEntity = this.world.createTransformEntity(modelMesh);
        try {
          this.modelEntity.addComponent(DistanceGrabbable, {
            movementMode: MovementMode.MoveFromTarget,
          });
        } catch {
          // ignore if component registration fails in non-XR contexts
        }
      }

      const incomingPosition = new Vector3(
        state.pos[0],
        state.pos[1],
        state.pos[2],
      );
      const incomingQuaternion = preserveRotation
        ? modelMesh.quaternion.clone()
        : new Quaternion(
            state.rot[0],
            state.rot[1],
            state.rot[2],
            state.rot[3],
          );

      // Apply position and (conditionally) rotation
      modelMesh.position.copy(incomingPosition);
      modelMesh.quaternion.copy(incomingQuaternion);
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

      // Show only the connected user id in the overlay (labelled "User id")
      this.debugEl.textContent = `User id: ${this.clientId || "-"}`;
    }

    update() {
      if (!this.clientId) {
        this.updateDebug();
        return;
      }

      const now = performance.now();
      this.scanMarker(now);

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
          markerID: this.markerID,
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

        this.send({
          t: "model_update",
          clientId: this.clientId,
          state: this.withMarkerLocalPose(state),
        });
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
      this.debugState = {
        ...this.debugState,
        markerID: this.markerID,
      };
      this.updateDebug();
    }

    dispose() {
      this.socket?.close();
    }
  };
}

export type { ModelState };
