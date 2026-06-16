# Force Field Explorer

A modern, from-scratch rebuild of [Tinker-FFE](https://github.com/TinkerTools/tinker-ffe),
the molecular-modeling GUI for the [Tinker](https://github.com/TinkerTools/tinker)
package. It aims to provide all the functionality of the original Java/Java3D
application with a modern, customizable look — and to keep running on Linux,
macOS, and Windows with minimal maintenance.

## Stack

- **Electron** — cross-platform desktop shell (bundles its own Chromium, so
  rendering is identical on every OS and unaffected by OS updates).
- **React + TypeScript** — application UI.
- **Three.js** — the 3D molecular viewport, built on WebGL2 with our own shaders
  (no third-party molecular viewer) so the visualization is fully customizable.
- **electron-vite** — dev server (HMR) and build pipeline.
- **electron-builder** — native installers (`.dmg` / `.AppImage`+`.deb` / `.exe`).

## Requirements

- Node.js 18+ (developed on Node 23).

## Commands

```bash
npm install        # install dependencies
npm run dev        # launch the app with hot reload
npm run typecheck  # type-check main, preload, and renderer
npm run build      # production build into out/
npm run package    # build + produce a native installer for the current OS
```

## Project layout

```
src/
  main/        Electron main process (window, and later Tinker job control)
  preload/     the single, typed bridge exposed to the renderer
  renderer/    the React UI
    src/
      App.tsx          root layout shell
      viewer/          the Three.js viewport ("our" renderer)
        Viewer.tsx     React wrapper owning the scene lifetime
        scene.ts       camera, controls, lights, render loop, molecule drawing
```

## Maintainability principles (non-negotiable)

The original app rotted because it depended on niche/proprietary/non-standard
pieces (Java3D, install4j, a JNI shim, `sun.misc`). To avoid repeating that:

1. **Own the core.** Parsers, the molecular model, and rendering shaders are our
   own code on top of frozen web standards (WebGL2) — nothing niche underneath
   to be abandoned.
2. **Minimize dependencies.** Every dependency is a future liability; keep the
   list small and audited.
3. **Pin versions; upgrade deliberately**, never on autopilot.
4. **CI on all three OSes from day one** so breakage surfaces immediately.
5. **Test parsers against real Tinker files** so the data layer stays provably
   correct.

## Status

Early scaffold: a running Electron + React window with a Three.js viewport
showing a placeholder molecule. Next up: load real Tinker `.xyz` files and draw
them with GPU impostor spheres/cylinders.

A read-only copy of the original application lives in `../tinker-ffe-original/`
(a sibling of this project directory) for reference while porting.
