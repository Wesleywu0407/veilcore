# Range assets

Made for `practice.html`, and kept apart from `../arena/` because nothing in the
duel uses them.

## `plate.glb` — the porcelain disc the target is painted on

Meshy text-to-3D preview, 2026-09-04. **832 triangles, one primitive, NO
textures, 0.05 MB.** Coloured in the game, like the vfx assets in `../arena/vfx`.

### The model is the plate. The rings are code. That split is the finding.

Meshy was asked for the rings three separate ways and painted them three
different ways: stepped trenches that went black in the range's light, pale
bands with no contrast at all, and finally a red dartboard — a colour this game
does not own. It is a diffusion model painting into a UV. It is very good at
glaze, chipping and a faceted rim, and it will not hold four exact concentric
circles in four exact hex values, because that is not the kind of thing it does.

Four exact concentric circles in four exact hex values is what CODE does, and
the code for them was already in practice.js. So the disc underneath is the
model, for the material and the silhouette, and the rings on top are
RingGeometry in the page's own `--paper`, `--violet` and `--gold`. Nothing is
left to a sampler in the part you have to aim at; nothing is drawn by hand in
the part that only has to look like porcelain.

The textured version was thrown away. Only the untextured preview is kept, which
is also why this is 0.05 MB and needs no shrinking.

### Getting the geometry took five prompts

1. *"A thin round face"* → a **dome**. "Thin" does not stop Meshy inflating.
2. *"Standing upright on its edge"* → grew a **plinth**. Anything implying
   support gets support. Say it "floats alone and touches nothing".
3. Rings asked for as geometry → **stepped trenches**, black in this light.
4. *"Completely smooth, no relief"* → **still carved rings**. The word "target"
   carries ring geometry with it and no amount of NO gets it out.
5. **What worked: ask for a blank plate.** "A plain blank circular porcelain
   plate, completely smooth and featureless" has nothing to carve.

Also: `texture_prompt` is capped at 800 characters, and the API only says so if
you print the raw response.
