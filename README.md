# Silicone Mould Maker

A browser app that turns an STL of an object (a teddy bear, a figurine, a soap shape…) into a
**3D-printable mould shell for silicone casting**. The shell follows the shape of the object at a
fixed distance, so you pour far less silicone than with a rectangular mould box (≈70 % less for
the demo teddy).

Everything runs locally in your browser. Nothing is uploaded.

## What it generates

| Part | Description |
| --- | --- |
| **Shell half A / B** | An offset shell around the master, split along a vertical plane. Each half has a flange that is lined up with **alignment pins** (blind sockets in both halves plus printable loose pins, held shut with external clamps) or, optionally, M3 bolt holes. The halves are exported lying on their flat split face, ready to print. |
| **Pour funnel** | Placed automatically at the highest point of the silicone cavity. |
| **Air vents** | The app works out where air would be trapped as silicone fills the mould (local high points of the cavity) and drills a vent above each one. Pockets that sit under an overhang of the model can't be vented; they're shown in red with advice. |
| **Base plate** | Seals the bottom of the shell. It has a pocket matching the master's footprint so you can glue the master in place, and a ridge that locates the shell. |

The lowest face of the model sits on the base plate and becomes the opening of the finished silicone
mould (where resin is poured in later), so orient the model with its flat bottom down.

## Settings

- **Silicone thickness**: the gap between the master and the shell (default 5 mm).
- **Shell wall**: the printed wall thickness.
- **Shape smoothing**: bridges narrow gaps and concave detail (for example between arms and body) so
  the shell is simpler and has fewer air traps. Set it to 0 to follow the model as closely as possible.
- **Split plane / offset**: where the shell is cut into two halves.
- **Quality**: the voxel grid resolution. Higher settings give smoother shells but take more time and memory.
- **Halves joined by** (Advanced): alignment pins + clamps (default), bolts, or nothing. Pin diameter, socket depth and clearance are adjustable; the pins can be printed from the exported pins STL or replaced with metal dowels / filament offcuts of the same diameter.
- **Advanced**: flange size, joint spacing, pour hole and funnel, vents, and base plate.

## How it works

1. The STL is voxelised. Parity rays are cast along all three axes and a majority vote decides
   inside/outside, so small holes in the mesh are tolerated.
2. An exact Euclidean distance transform gives the distance from every voxel to the master.
   Optional morphological closing (dilate by *g + R*, erode by *R*) smooths the shape.
3. The shell is the band `g ≤ distance ≤ g + wall`, combined with flanges, the funnel, vents, pin sockets / bolt
   holes and the split plane as implicit fields.
4. A merge tree over the cavity, built from the top layer down, finds every local high point where
   air would collect, together with its depth. The deepest one gets the pour funnel and the rest get vents.
5. Marching cubes extracts closed, manifold meshes, then light Taubin smoothing is applied. The flat
   faces stay locked so the halves seal.

The heavy work runs in a Web Worker. A 160–200 grid takes a few seconds.

## Development

```bash
npm install
npm run dev      # dev server
npm run build    # type-check + production build into dist/
npm test         # generates a mould for the demo teddy in Node and checks the meshes are watertight
```

The build is static with relative paths, so `dist/` can be hosted anywhere (GitHub Pages, Netlify, etc.).

### GitHub Pages

`.github/workflows/deploy.yml` builds and deploys the site on every push to `main`. To turn it on, go to
**Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. The site is published at
`https://<user>.github.io/silicone-mould-maker/`.

## Casting workflow

1. Print both halves and the base plate (PLA/PETG, 3+ perimeters).
2. Glue the master into the footprint pocket on the base plate.
3. Close the halves around it with the alignment pins in their sockets, clamp the flanges shut (or bolt them), seat them inside the base ridge and seal the seams (hot glue or plasticine).
4. Mix and degas the silicone. Pour slowly in a thin stream into the funnel until silicone appears at the vents.
5. Once cured, open the shell and remove the master (cut the silicone along one side if needed).
   Put the silicone glove back into the shell for support while you cast.
