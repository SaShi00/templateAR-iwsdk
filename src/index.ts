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
import { makeNetworkSyncSystem } from "./sync/networkSystem";

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
    camera: true,
  },
}).then((world) => {
  const { camera } = world;
  camera.position.set(0, 1, 0.5);

  const { scene: modelMesh } = AssetManager.getGLTF("model")!;
  modelMesh.position.set(0, 1, -2);
  modelMesh.scale.setScalar(0.2);
  // Hide the model until a QR marker is scanned and placement is known
  modelMesh.visible = false;

  // Create the entity now but keep the mesh hidden until placement is applied.
  const entity = world
    .createTransformEntity(modelMesh)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
    });

  // Register the uniform scale helper and the networking sync system
  world.registerSystem(makeModelUniformScaleSystem(modelMesh));
  world.registerSystem(makeNetworkSyncSystem(entity, modelMesh));
});
