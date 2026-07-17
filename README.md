# Tinker Studio: Modern Interactive GUI for Tinker

Tinker Studio is a reimplementation of [Tinker-FFE](https://github.com/TinkerTools/tinker-ffe),
intended as a molecular modeling GUI for [Tinker](https://github.com/TinkerTools/tinker).
Written largely in TypeScript, Tinker Studio aims to provide all the functionality and
more of the original FFE Java/Java3D application within a modern, customizable and easily 
maintained package.

## Downloadable Executables

Standalone executables for Linux, macOS and Windows are available on GitHub for the current
release of Tinker Studio. Installation packages can be found under Releases on right side of
the main GitHub site for Tinker Studio. Note the current macOS executables are not notarized
by Apple, so the macOS Gatekeeper mechanism must be disabled to allow the executables to run.

Linux is offered in three formats: a `.deb` for Debian and Ubuntu, an `.AppImage`, and a
`.tar.gz` that runs on any distribution. The AppImage needs FUSE 2, which Ubuntu has not
installed by default since 24.04; should it fail with `dlopen(): error loading libfuse.so.2`,
either install FUSE 2 (`sudo apt install libfuse2t64` on Ubuntu), launch it once with
`APPIMAGE_EXTRACT_AND_RUN=1`, or just use the `.tar.gz`, which has no dependencies and needs
no root — unpack it and run `./tinker-studio`.

## Software Stack

- **Electron:** cross-platform desktop shell; bundles its own Chromium, so
  rendering is identical on every OS and unaffected by OS updates
- **React & TypeScript:** application user interface
- **Three.js:** the 3D molecular viewport, built on WebGL2 with its own shaders
  (no third-party molecular viewer) so the visualization is fully customizable
- **electron-vite:** dev server (HMR) and build pipeline
- **electron-builder:** native installers (`.AppImage`, `.deb` & `.tar.gz` for
  Linux, `.dmg` for macOS, and `.exe` for Windows)

## Build Requirements

- Node.js 18+ (developed on Node 23).

## Launch Commands

```bash
npm install        # install dependencies
npm run dev        # launch the app with hot reload
npm run typecheck  # type-check main, preload, and renderer
npm run build      # production build into out/
npm run package    # build and produce a native installer for the current OS
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

The original FFE app was hard to maintain due to its dependence on niche, proprietary
and non-standard components (Java3D, install4j, JNI shim, `sun.misc`). To avoid that
situation Tinker Studio aims to:

- **Own the Core:** the parsers, the molecular model, and rendering shaders are our
  own code on top of frozen web standards (WebGL2) with nothing niche underneath
  to be abandoned
- **Minimize Dependencies:** every dependency is a future liability; keep the
  list small and audited
- **Pin Versions & Upgrade Carefully:** never update on autopilot
- **CI on all OSes from the Start:** so breakage surfaces immediately
- **Test Parsers on Tinker Files:** so the data layer stays provably
  correct

## Current Status

At present, Tinker Studio is a working application, with most of the original FFE's
functionality in place:

- **Open & Save:** Tinker XYZ & ARC, PDB, MDL SDF/MOL, and INT (z-matrix), with
  automatic bond perception and force-field (`.prm`) pickup from a sibling
  `.key`. Export to Tinker XYZ, plain XYZ, MOL, or PDB
- **Downloads:** structures from PubChem, NCI, and the RCSB PDB
- **Rendering:** via our own WebGL2 shaders — GPU impostor spheres and instanced
  cylinder bonds, with ball-and-stick, spacefill,  wireframe and tube
  representations, coloring by element/residue/chain/charge, depth cueing,
  outline + ambient-occlusion post-FX, and an adjustable surface finish
- **Multiple Systems:** open at once: list, toggle visibility, merge, and place
  each with a rigid-body move/rotate gizmo
- **Selection & Measurement:** by atom, residue, molecule and system, from either
  the 3D view or the atom-hierarchy browser; distance, angle and dihedral
- **Trajectories:** large `.arc` files are indexed lazily and scrubbable while
  still indexing; binary `.dcd` files attach to a structure and stream the same
  way; playback has speed, skip and oscillate controls
- **Tinker Jobs:** launch any Tinker program from a data-driven option form (the
  catalogs are generated from the original FFE `commands.xml` and `keywords.xml`),
  stream its output live, watch a running minimize or dynamics job's coordinates
  as they are written, and load the result back in as a new system
- **Packaging:** native installers for macOS, Windows, and Linux, built in CI

To be implemented: per-atom vector display (force, velocity and induced dipole
vectors from `.dyn`, `.vel` and `.uind` files), molecular surfaces, and biopolymer 
secondary structure cartoons.
