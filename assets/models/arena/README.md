# Arena character drop point

Export the optimized, auto-rigged Meshy character as:

`sealed-porcelain-duelist.glb`

Place it beside this file. `arena.html` detects it automatically, loads one
source asset, creates safe skinned clones for both teams, normalizes the height,
and keeps the procedural duelist as a fallback if the file is absent.

Friday export target: 20K–25K triangles, 2K PBR textures, GLB with idle and
run/walk clips when available. No Blender edit is required for the first pass.
