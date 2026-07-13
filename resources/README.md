# Bundled Tinker parameters

## `basic.prm`

A copy of Tinker's generic **`basic.prm`** force field, shipped inside Tinker Studio
so that molecules built in the Molecule Builder or downloaded from PubChem / NCI can
be assigned `basic.prm` atom types (`10 × atomic number + number of attached atoms`)
and run/minimized **without depending on the user's local Tinker installation**
having a copy.

Systems from the Builder / PubChem / NCI carry a key with `parameters basic.prm`;
Tinker Studio resolves that name to *this* bundled file at job time — unless the
user attaches a key that names a different parameter file, which takes precedence.

### Updating to a newer basic.prm

Replace this single file with the new version and rebuild:

```
cp /path/to/new/basic.prm resources/basic.prm
npm run build      # or: npm run package
```

Nothing else needs to change: the file is shipped verbatim via electron-builder's
`extraResources` (see `electron-builder.yml`) and located at runtime by
`bundledBasicPrmPath()` in `src/main/index.ts`.
