import {
  AssetManifest,
  AssetType,
  SessionMode,
  AssetManager,
  Object3D,
  DistanceGrabbable,
  MovementMode,
  World,
} from "@iwsdk/core";
import { makeQrAnchorSystem } from "./qrAnchorSystem";
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
    grabbing: {
      useHandPinchForGrab: true,
    },
    physics: false,
    sceneUnderstanding: true,
    environmentRaycast: true,
    camera: true,
  },
}).then((world) => {
  const { camera } = world;
  camera.position.set(0, 1, 0.5);

  const qrAnchor = new Object3D();
  qrAnchor.name = "qr-anchor";
  const anchorEntity = world.createTransformEntity(qrAnchor);

  const { scene: modelMesh } = AssetManager.getGLTF("model")!;
  modelMesh.name = "qr-model";
  modelMesh.position.set(0, 0, 0);
  modelMesh.scale.setScalar(0.2);
  modelMesh.visible = false;

  const entity = world
    .createTransformEntity(modelMesh, { parent: anchorEntity })
    .addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
      rotate: true,
      translate: true,
      translateMin: [0, 0, -0.1],
      translateMax: [0, 0, 0.1],
      scale: true,
    });

  world.registerSystem(
    makeQrAnchorSystem({
      anchor: qrAnchor,
      model: modelMesh,
      markerPhysicalSizeMeters: 0.145,
      scanIntervalMs: 200,
    }),
  );
  world.registerSystem(
    makeModelUniformScaleSystem(modelMesh, {
      lockedLocalPosition: [0, 0, 0],
      lockPositionAxes: [true, true, false],
      minScale: 0.1,
      maxScale: 2,
    }),
  );
});
