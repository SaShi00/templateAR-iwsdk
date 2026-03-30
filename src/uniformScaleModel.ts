import { Object3D, Vector3, createSystem } from "@iwsdk/core";

type UniformScaleOptions = {
  lockedLocalPosition?: [number, number, number];
  lockPositionAxes?: [boolean, boolean, boolean];
  minScale?: number;
  maxScale?: number;
};

export function floatsClose(a: number, b: number, eps = 1e-4) {
  return Math.abs(a - b) <= eps;
}

export function meshToTransform(mesh: any) {
  return {
    position: mesh.position.clone(),
    rotation: mesh.rotation.clone(),
    scale: mesh.scale.clone(),
    matrixWorld: mesh.matrixWorld.clone(),
  };
}

export function makeModelUniformScaleSystem(
  modelMesh: Object3D,
  {
    lockedLocalPosition = [0, 0, 0],
    lockPositionAxes = [true, true, true],
    minScale = 0.05,
    maxScale = Number.POSITIVE_INFINITY,
  }: UniformScaleOptions = {},
) {
  return class ModelUniformScaleSystem extends createSystem({}, {}) {
    private model: Object3D | null = null;
    private readonly lockedPosition = new Vector3(...lockedLocalPosition);

    init() {
      this.model = modelMesh;
    }

    update() {
      if (!this.model) return;

      if (
        (lockPositionAxes[0] &&
          !floatsClose(this.model.position.x, this.lockedPosition.x)) ||
        (lockPositionAxes[1] &&
          !floatsClose(this.model.position.y, this.lockedPosition.y)) ||
        (lockPositionAxes[2] &&
          !floatsClose(this.model.position.z, this.lockedPosition.z))
      ) {
        this.model.position.set(
          lockPositionAxes[0] ? this.lockedPosition.x : this.model.position.x,
          lockPositionAxes[1] ? this.lockedPosition.y : this.model.position.y,
          lockPositionAxes[2] ? this.lockedPosition.z : this.model.position.z,
        );
      }

      const unclampedScale = this.model.scale.x;
      const uniformScale = Math.min(
        maxScale,
        Math.max(minScale, unclampedScale),
      );
      if (
        !floatsClose(this.model.scale.y, uniformScale) ||
        !floatsClose(this.model.scale.z, uniformScale) ||
        !floatsClose(this.model.scale.x, uniformScale)
      ) {
        this.model.scale.setScalar(uniformScale);
      }

      const currentWorldTransform = meshToTransform(this.model);
      // currentWorldTransform available for further logic
    }
  };
}
