# templateAR-iwsdk

Local AR QR-anchor example built with IWSDK.

The app uses a QR code to anchor one 3D model in the room. When the user scans the QR code, the app estimates the marker pose, places the model on the marker, and keeps the model position attached to that QR code while allowing grab-based rotation and uniform scale changes.

## What it does

- Loads a GLTF model into an AR scene.
- Captures a back-facing camera stream and scans it with `jsQR`.
- Uses the QR marker pose as the anchor for model placement.
- Keeps the model hidden until a valid QR pose is detected.
- Lets the user rotate the model with one hand and uniformly scale it with two hands.
- Prevents position changes from grab interactions so the model always stays on the QR code.

## Project Structure

```text
index.html
package.json
README.md
tsconfig.json
vite.config.ts
public/
src/
	index.ts
	qrAnchorSystem.ts
	uniformScaleModel.ts
```

## Runtime Flow

1. `npm run dev` starts the Vite dev server on `https://localhost:8081`.
2. `src/index.ts` creates the IWSDK world, loads the model, and registers the systems.
3. `src/qrAnchorSystem.ts` creates a back-facing camera probe and scans frames with `jsQR`.
4. When a QR code is detected, the system estimates the marker pose from the QR corners.
5. The QR anchor entity is moved to the marker center and its orientation is updated to match the QR code.
6. The model remains parented under that anchor so its position stays locked to the QR code.
7. Grab interactions modify only the child model's local rotation and uniform scale.

## Important Files

- [src/index.ts](src/index.ts) creates the IWSDK world, loads the model, and registers systems.
- [src/qrAnchorSystem.ts](src/qrAnchorSystem.ts) handles QR scanning, marker pose estimation, and anchor updates.
- [src/uniformScaleModel.ts](src/uniformScaleModel.ts) keeps the model uniformly scaled.

## Scripts

- `npm run dev` starts the Vite dev server on `https://localhost:8081` with the IWSDK dev plugin enabled.
- `npm run build` builds the app for production into `dist/`.
- `npm run preview` previews the production build locally.

## Setup

```bash
npm install
npm run dev
```

Open `https://localhost:8081` in the browser.

## How the QR anchoring works

The QR code is the live anchor for the model.

- The client scans the QR code.
- The client estimates the marker pose from the QR corners.
- The parent anchor entity moves to the QR center and follows the latest marker pose.
- The model stays parented under that anchor, so the model position remains on the QR code.
- One-hand grab changes rotation.
- Two-hand grab changes scale.
- A constraint system forces scale to remain uniform and resets local translation to zero.

## Troubleshooting

- If the model does not appear, confirm the QR code is visible to the device camera and camera permission was granted.
- If the model appears but does not track well, check that the printed QR code size matches the `markerPhysicalSizeMeters` value in `src/index.ts`.
- If rotation or scaling works but the marker pose feels unstable, increase the QR size or improve lighting so `jsQR` can detect corners more reliably.

## Notes

- `src/qrAnchorSystem.ts` uses `jsQR` plus marker pose estimation to derive the QR anchor transform.
- The model hierarchy is intentionally split into a QR-following parent anchor and a grabbable child model so grab interaction never changes the anchored position.
