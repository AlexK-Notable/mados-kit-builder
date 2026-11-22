# Making the builder faster, smaller and steadier: a running log

Things noticed while working on the builder that would make it faster, smaller or less
likely to break. Each entry says what was seen, what could be done, and roughly what it
would cost. "Done" entries stay here with the numbers they produced.

## Done

- **Compact mesh files instead of STL** (2026-11-21). The app's data was 296 MB, nearly all
  of it binary STL, which writes every corner of every triangle in full. Meshes are now
  kept as numbered points in whole micrometres plus triangles that name them, stored as
  differences and gzipped (`meshfile.py`, `app/mesh.js`). Result: 296 MB to 25 MB, and a
  20 mm block's print file is 0.16 MB to download instead of 1.8 MB. The download the
  user gets is still ordinary STL.
- **STL had been quietly breaking some meshes.** Thirteen of the 195 stored STLs did not
  read back as closed solids: STL keeps 32-bit numbers, which merged points that lay a
  hair apart. The compact form keeps points apart by number, so what is stored is exactly
  the solid that was built.

## Open
