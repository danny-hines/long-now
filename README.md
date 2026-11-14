# Long Now — the life of the solar system

Watch the solar system from its birth in a collapsing cloud 4.568 billion years ago to the Sun's
death as a white dwarf 7.7 billion years from now. Scrub anywhere on the timeline, play at anything
from real time to 100 million years a second — and then meddle: push a world off course or open a
temporary gravity well, and watch the consequences play out.

```bash
npm install
npm run dev
```

Then open the printed URL. `npm test` runs the numerical checks for the physics.

## Playing

| | |
|---|---|
| Drag / scroll | orbit the camera / zoom from a planet's surface out to the edge of the system |
| Click a body | follow it (double-click to fly in) |
| Timeline | drag to scrub, scroll to zoom into an era, click a flag to jump to that event |
| Space, `,` `.` | play/pause, slower/faster |
| `←` `→` | previous / next event |
| `0`–`9` | whole system, Sun, Mercury … Neptune |
| ⌘Z | undo your last intervention |

**Nudge a body** gives a planet or moon an instantaneous change of velocity (speed up, slow down,
toward or away from the Sun, up or down out of the plane). The dashed line previews the new orbit.

**Gravity well** places a point mass (from a fraction of an Earth to a full solar mass) at a spot
you click, for a chosen time. It pulls on everything, the Sun included, then vanishes.

Each intervention is a flag on the timeline. Jump back before it and the world is untouched; remove
it (✕, *Undo last*, or ⌘Z) and natural history is restored from that moment. Intervening at an
earlier time than an existing intervention replaces the later ones.

## What is simulated, and how

- **The Sun** follows published stellar-evolution tracks (`src/sim/sun.js`): the faint young Sun,
  steady brightening, the red-giant branch to 256 R☉ with a third of its mass lost, the helium
  flash, the asymptotic giant branch, a planetary nebula and a 0.54 M☉ white dwarf.
- **Natural history** (`src/sim/bodies.js`, `history.js`): today's orbits are JPL mean elements.
  Formation is scripted from the mainstream picture: giant planets grow in the gas disc and migrate,
  the rocky planets assemble, Theia strikes Earth and the Moon recedes ever since. As the Sun sheds
  mass every orbit widens (a·M☉ is conserved) and anything inside its tidal reach is swallowed.
- **After an intervention** (`src/sim/nbody.js`, `worker.js`) a real N-body integration runs in a
  background thread: a Wisdom–Holman symplectic map for quiet stretches (energy conserved to ~1e-8
  over 20,000 years) that hands over to an adaptive Bulirsch–Stoer integrator for close encounters,
  Sun-grazing passages and active gravity wells. Collisions merge bodies, moons can be stripped,
  captured or lost, and unbound bodies are flagged as ejected. Results stream back like a video
  buffer: the solid teal stretch of the timeline is simulated, the dashed stretch is a projection
  from the last simulated orbits.
- **Surfaces** (`src/sim/surface.js`, `src/render`): Earth's coastlines for the last 1.8 billion
  years are real plate reconstructions (see `CREDITS.md`); earlier and future maps are procedural.
  Oceans, ice, vegetation, haze and molten rock respond to the sunlight a world actually receives,
  so moving Earth freezes or boils it, and the swelling Sun eventually does the same.
- **Events** are re-derived whenever the world line changes: collisions, ejections and climate
  turning points are added, and natural milestones that can no longer happen are struck through.

## Honest limits

- Before 4.45 billion years ago the planets are still forming and cannot be perturbed.
- The N-body run covers the aftermath (it continues for as long as the system looks unstable, at
  roughly 20,000 simulated years per second for the full system). Beyond that, orbits are held
  fixed apart from the Sun's evolution, so slow chaotic instabilities over billions of years are
  not captured.
- Planet surfaces other than Earth's are procedural, not maps. The asteroid and Kuiper belts are
  visual only. Tides, relativity and the giant planets' own moons are not modelled.
- Deep-time climate and the future supercontinent are illustrative, and several dates in the
  record (Venus losing its water, the age of Saturn's rings) are genuinely uncertain.

## Rebuilding the continent data

```bash
node tools/fetch-paleo.mjs   # downloads and rasterises reconstructions (cached in tools/.cache)
node tools/pack-paleo.mjs    # adds procedural frames and writes public/data/paleo.bin
```

## Licence

The code is released under the [MIT licence](LICENSE).

The continent data in `public/data/paleo.bin` is derived from the Cao et al. (2024) plate model and
remains under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); if you redistribute it,
keep the attribution in [CREDITS.md](CREDITS.md).
