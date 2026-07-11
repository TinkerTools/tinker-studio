# Tinker Studio

A modern, from-scratch rebuild of [Tinker-FFE](https://github.com/TinkerTools/tinker-ffe),
intended as a molecular modeling GUI for the [Tinker](https://github.com/TinkerTools/tinker)
package. It aims to provide all the functionality of the original FFE Java/Java3D application
with a modern, customizable look — and to keep running on Linux, macOS, and Windows with
minimal maintenance.

## Software Stack

- **Electron** — cross-platform desktop shell (bundles its own Chromium, so
  rendering is identical on every OS and unaffected by OS updates).
- **React + TypeScript** — application UI.
- **Three.js** — the 3D molecular viewport, built on WebGL2 with our own shaders
  (no third-party molecular viewer) so the visualization is fully customizable.
- **electron-vite** — dev server (HMR) and build pipeline.
- **electron-builder** — native installers (`.dmg` / `.AppImage`+`.deb` / `.exe`).

## Build Requirements

- Node.js 18+ (developed on Node 23).

## Launch Commands

```bash
npm install        # install dependencies
npm run dev        # launch the app with hot reload
npm run typecheck  # type-check main, preload, and renderer
npm run build      # production build into out/
npm run package    # build + produce a native installer for the current OS
```

## Project Organization

```
src/
  main/        Electron main process — window, native menu, file I/O, and
               privileged operations the sandboxed UI can't do directly:
    index.ts       window, menu, IPC handlers, Tinker job spawning, downloads
    trajectory.ts  lazy byte-offset indexing of large .arc files (frames on demand)
    dcd.ts         binary .dcd trajectory reader (fixed-size frames)
    liveJob.ts     stream a running minimize/dynamics job's growing output
  preload/     the single, typed bridge (window.tinker) exposed to the renderer
  renderer/    the React UI
    src/
      App.tsx          root layout shell (sidebar + viewport, action dispatch)
      AtomBrowser.tsx  residue/atom hierarchy + selection
      CommandsModal.tsx  data-driven Tinker program launcher + live log
      KeywordsModal.tsx  .key keyword reference + composer
      JobsModal.tsx    running/finished Tinker jobs
      core/            framework-free data model (no Three.js / Electron):
        types.ts, system.ts          molecular model + multi-system state
        parseXyz/Pdb/Sdf/Int/Prm.ts  Tinker XYZ/ARC, PDB, SDF/MOL, INT, .prm
        writers.ts, writeXyz.ts      structure export (txyz/xyz/mol/pdb)
        bondPerception, select,      bond detection, selection, geometry,
          measure, transform,          rigid-body transforms, frame windowing
          frameWindow, elements
      data/            Tinker command/keyword catalogs (generated JSON + types)
      viewer/          the Three.js viewport ("our" renderer)
        Viewer.tsx          React wrapper owning the scene lifetime
        scene.ts            camera, controls, lights, render loop, drawing, picking
        impostorSpheres.ts  GPU ray-traced sphere shader (atoms)
        postShaders.ts      outline / ambient-occlusion post-processing
        renderOptions.ts    representations, color modes, graphics settings
      samples/         bundled example structures (ethanol, crambin, …)
```

## Maintainability Principles

The original FFE app became hard to maintain because it depended on niche, proprietary and non-standard components (Java3D, install4j, a JNI shim, `sun.misc`). To avoid that situation Tinker Studio aims to:

1. **Own the core.** Parsers, the molecular model, and rendering shaders are our
   own code on top of frozen web standards (WebGL2) — nothing niche underneath
   to be abandoned.
2. **Minimize dependencies.** Every dependency is a future liability; keep the
   list small and audited.
3. **Pin versions; upgrade deliberately**, never on autopilot.
4. **CI on all three OSes from day one** so breakage surfaces immediately.
5. **Test parsers against real Tinker files** so the data layer stays provably
   correct.

## Current Status

At present, Tinker Studio is a working application, with most of the original FFE's functionality in place:

- **Open / save** Tinker XYZ & ARC, PDB, MDL SDF/MOL, and INT (z-matrix), with
  automatic bond perception and force-field (`.prm`) pickup from a sibling
  `.key`. Export to Tinker XYZ, plain XYZ, MOL, or PDB.
- **Download** structures from PubChem, NCI, and the RCSB PDB.
- **Rendering** via our own WebGL2 shaders — GPU impostor spheres and instanced
  cylinder bonds, with ball-and-stick / spacefill / sticks / wireframe / tube
  representations, element/residue/chain/charge coloring, depth cueing,
  outline + ambient-occlusion post-FX, and an adjustable surface finish.
- **Multiple systems** open at once: list, toggle visibility, merge, and place
  each with a rigid-body move/rotate gizmo.
- **Selection & measurement** by atom / residue / molecule / system, from either
  the 3D view or the atom-hierarchy browser; distance, angle, and dihedral.
- **Trajectories**: large `.arc` files are indexed lazily and scrubbable while
  still indexing; binary `.dcd` files attach to a structure and stream the same
  way; playback has speed / skip / oscillate controls.
- **Tinker jobs**: launch any Tinker program from a data-driven option form (the
  catalogs are generated from the original FFE's `commands.xml` / `keywords.xml`),
  stream its output live, watch a running minimize/dynamics job's coordinates as
  they're written, and load the result back in as a new system.
- **Packaging**: native installers for macOS, Windows, and Linux, built in CI.

To be implemented: per-atom vector display (force/velocity/induced-dipole arrows from `.dyn` / `.uind`), molecular surfaces, and real secondary-structure cartoons.
