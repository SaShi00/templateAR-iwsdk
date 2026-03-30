import {
  CameraSource,
  CameraUtils,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
  createSystem,
} from "@iwsdk/core";
import jsQR from "jsqr";

type QRAnchorSystemOptions = {
  anchor: Object3D;
  model: Object3D;
  markerPhysicalSizeMeters?: number;
  scanIntervalMs?: number;
  cameraHorizontalFovDeg?: number;
  markerNormalOffsetMeters?: number;
};

type QRScanSample = {
  width: number;
  height: number;
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
  bottomRight: { x: number; y: number };
};

type MarkerPoseEstimate = {
  matrix: Matrix4;
  position: Vector3;
  quaternion: Quaternion;
};

export function makeQrAnchorSystem({
  anchor,
  model,
  markerPhysicalSizeMeters = 0.145,
  scanIntervalMs = 200,
  cameraHorizontalFovDeg = 63,
  markerNormalOffsetMeters = 0,
}: QRAnchorSystemOptions) {
  return class QrAnchorSystem extends createSystem({}, {}) {
    private readonly anchorObject = anchor;
    private readonly modelObject = model;
    private cameraEntity: any = null;
    private lastScanTime = 0;
    private readonly markerCenter = new Vector3(
      markerPhysicalSizeMeters * 0.5,
      markerPhysicalSizeMeters * 0.5,
      0,
    );
    private readonly markerNormal = new Vector3(0, 0, 1);
    private readonly anchorPosition = new Vector3();
    private readonly anchorOffset = new Vector3();

    init() {
      this.createCameraProbe();
      this.anchorObject.visible = false;
    }

    update() {
      const now = performance.now();
      if (now - this.lastScanTime < scanIntervalMs) {
        return;
      }

      this.lastScanTime = now;
      this.scanAndApplyMarkerPose();
    }

    private createCameraProbe() {
      if (this.cameraEntity) {
        return;
      }

      const probe = new Object3D();
      probe.visible = false;
      this.cameraEntity = this.world.createTransformEntity(probe);
      this.cameraEntity.addComponent(CameraSource, {
        facing: "back",
        width: 1280,
        height: 720,
        frameRate: 15,
      });
    }

    private scanAndApplyMarkerPose() {
      if (!this.cameraEntity) {
        return;
      }

      const canvas = CameraUtils.captureFrame(this.cameraEntity);
      if (!canvas) {
        return;
      }

      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return;
      }

      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const qrCode = jsQR(imageData.data, canvas.width, canvas.height, {
        inversionAttempts: "dontInvert",
      });

      if (!qrCode?.location) {
        return;
      }

      const sample: QRScanSample = {
        width: canvas.width,
        height: canvas.height,
        topLeft: {
          x: qrCode.location.topLeftCorner.x,
          y: qrCode.location.topLeftCorner.y,
        },
        topRight: {
          x: qrCode.location.topRightCorner.x,
          y: qrCode.location.topRightCorner.y,
        },
        bottomLeft: {
          x: qrCode.location.bottomLeftCorner.x,
          y: qrCode.location.bottomLeftCorner.y,
        },
        bottomRight: {
          x: qrCode.location.bottomRightCorner.x,
          y: qrCode.location.bottomRightCorner.y,
        },
      };

      const markerPose = this.solveMarkerPose(sample);
      if (!markerPose) {
        return;
      }

      this.applyMarkerPose(markerPose);
    }

    private applyMarkerPose(markerPose: MarkerPoseEstimate) {
      this.anchorPosition
        .copy(this.markerCenter)
        .applyMatrix4(markerPose.matrix);
      if (markerNormalOffsetMeters !== 0) {
        this.anchorOffset
          .copy(this.markerNormal)
          .applyQuaternion(markerPose.quaternion)
          .multiplyScalar(markerNormalOffsetMeters);
        this.anchorPosition.add(this.anchorOffset);
      }

      this.anchorObject.position.copy(this.anchorPosition);
      this.anchorObject.quaternion.copy(markerPose.quaternion);
      this.anchorObject.scale.set(1, 1, 1);
      this.anchorObject.visible = true;
      this.modelObject.visible = true;
    }

    private solveMarkerPose(sample: QRScanSample): MarkerPoseEstimate | null {
      const fieldOfViewRad = (cameraHorizontalFovDeg * Math.PI) / 180;
      const focalLengthPx = sample.width / (2 * Math.tan(fieldOfViewRad / 2));
      const cx = sample.width / 2;
      const cy = sample.height / 2;

      const homography = this.solveHomography([
        { X: 0, Y: 0, u: sample.topLeft.x, v: sample.topLeft.y },
        {
          X: markerPhysicalSizeMeters,
          Y: 0,
          u: sample.topRight.x,
          v: sample.topRight.y,
        },
        {
          X: markerPhysicalSizeMeters,
          Y: markerPhysicalSizeMeters,
          u: sample.bottomRight.x,
          v: sample.bottomRight.y,
        },
        {
          X: 0,
          Y: markerPhysicalSizeMeters,
          u: sample.bottomLeft.x,
          v: sample.bottomLeft.y,
        },
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
      const kInvH00 = invFx * h00 - cx * invFx * h20;
      const kInvH01 = invFx * h01 - cx * invFx * h21;
      const kInvH02 = invFx * h02 - cx * invFx * h22;
      const kInvH10 = invFy * h10 - cy * invFy * h20;
      const kInvH11 = invFy * h11 - cy * invFy * h21;
      const kInvH12 = invFy * h12 - cy * invFy * h22;
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

    private solveHomography(
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

    private solveGaussian(
      matrix: number[][],
      vector: number[],
    ): number[] | null {
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
          if (row === pivot) {
            continue;
          }

          const factor = augmented[row][pivot];
          if (factor === 0) {
            continue;
          }

          for (let column = pivot; column <= size; column += 1) {
            augmented[row][column] -= factor * augmented[pivot][column];
          }
        }
      }

      return augmented.map((row) => row[size]);
    }
  };
}
