import {
  AssetManifest,
  AssetType,
  SessionMode,
  AssetManager,
  World,
  DistanceGrabbable,
  MovementMode,
  Object3D,
  Mesh,
  MeshBasicMaterial,
  CylinderGeometry,
  ConeGeometry,
} from "@iwsdk/core";
import { makeModelUniformScaleSystem } from "./uniformScaleModel.js";
import { makeNetworkSyncSystem } from "./sync/networkSystem.js";

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

  const arrowRoot = new Object3D();
  const arrowBody = new Mesh(
    new CylinderGeometry(0.015, 0.015, 0.42, 12),
    new MeshBasicMaterial({ color: 0xff0000 }),
  );
  arrowBody.rotation.z = Math.PI / 2;
  arrowBody.position.x = 0.21;

  const arrowHead = new Mesh(
    new ConeGeometry(0.06, 0.18, 16),
    new MeshBasicMaterial({ color: 0xff0000 }),
  );
  arrowHead.rotation.z = -Math.PI / 2;
  arrowHead.position.x = 0.39;

  arrowRoot.add(arrowBody);
  arrowRoot.add(arrowHead);
  arrowRoot.position.set(0, 1, -1.4);
  arrowRoot.scale.setScalar(0.25);
  arrowRoot.visible = false;

  const arrowEntity = world
    .createTransformEntity(arrowRoot)
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
    });

  // Register the uniform scale helper and the networking sync system
  world.registerSystem(makeModelUniformScaleSystem(modelMesh));
  world.registerSystem(makeModelUniformScaleSystem(arrowRoot));
  world.registerSystem(
    makeNetworkSyncSystem(entity, modelMesh, {
      objectId: "model-1",
    }),
  );
  world.registerSystem(
    makeNetworkSyncSystem(arrowEntity, arrowRoot, {
      objectId: "arrow-1",
    }),
  );
});
