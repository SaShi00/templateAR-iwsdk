import { createSystem } from "@iwsdk/core";

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

export function makeModelUniformScaleSystem(modelMesh: any) {
  return class ModelUniformScaleSystem extends createSystem({}, {}) {
    private model: any = null;

    init() {
      this.model = modelMesh;
    }

    update() {
      if (!this.model) return;
      const uniformScale = this.model.scale.x;
      if (
        !floatsClose(this.model.scale.y, uniformScale) ||
        !floatsClose(this.model.scale.z, uniformScale)
      ) {
        this.model.scale.setScalar(uniformScale);
      }
      const currentWorldTransform = meshToTransform(this.model);
      // currentWorldTransform available for further logic
    }
  };
}
