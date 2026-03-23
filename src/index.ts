import {
  AssetManifest,
  AssetType,
  SessionMode,
  AssetManager,
  World,
  DistanceGrabbable,
  MovementMode,
  Transform,
} from "@iwsdk/core";
import { makeModelUniformScaleSystem } from "./uniformScaleModel";

const assets: AssetManifest = {
  model: {
    url: "./model.glb",
    type: AssetType.GLTF,
    priority: "critical",
  },
};

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveAR,
    offer: "always",
    features: {
      handTracking: true,
      anchors: true,
      hitTest: true,
      planeDetection: true,
      meshDetection: true,
      layers: true,
    },
  },
  features: {
    locomotion: false,
    grabbing: true,
    physics: false,
    sceneUnderstanding: true,
    environmentRaycast: true,
  },
}).then((world) => {
  const { camera } = world;
  camera.position.set(0, 1, 0.5);

  const { scene: modelMesh } = AssetManager.getGLTF("model")!;
  modelMesh.position.set(0, 1, -2);
  modelMesh.scale.setScalar(1);

  const entity = world
    .createTransformEntity(modelMesh)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
    });

  // Register the system so its update() runs each frame
  world.registerSystem(makeModelUniformScaleSystem(modelMesh));
});
