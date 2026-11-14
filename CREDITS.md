# Credits

## Paleogeography

Continental outlines from 1.8 billion years ago to the present are plate-tectonic
reconstructions from:

> Cao, X., Collins, A. S., Pisarevsky, S., Flament, N., Li, S., Hasterok, D., & Müller, R. D. (2024).
> *Earth's tectonic and plate boundary evolution over 1.8 billion years.* Geoscience Frontiers, 15(6), 101922.

retrieved through the [GPlates Web Service](https://gws.gplates.org) (EarthByte Group, University of Sydney)
and distributed under the [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) licence.
The outlines were rasterised to 0.5° land masks (`public/data/paleo.bin`) by `tools/fetch-paleo.mjs` and
`tools/pack-paleo.mjs`. Frames older than 1.8 Ga and all future frames are procedural, not data.

## Science references

- Solar evolution: Schröder, K.-P. & Smith, R. C. (2008), *Distant future of the Sun and Earth revisited*, MNRAS 386, 155;
  Gough, D. O. (1981), *Solar interior structure and luminosity variations*, Solar Physics 74, 21.
- Present-day orbits: Standish, E. M., *Keplerian Elements for Approximate Positions of the Major Planets*, JPL Solar System Dynamics.
- N-body methods: Wisdom & Holman (1991); Duncan, Levison & Lee (1998) (democratic-heliocentric splitting);
  Bulirsch & Stoer (1966); Rein & Tamayo (2015) (universal-variable Kepler solver).
- Habitable-zone limits: Kopparapu et al. (2013); Earth–Moon distance history: Farhat et al. (2022) and references therein.

## Software

[three.js](https://threejs.org) (MIT), [Vite](https://vitejs.dev) (MIT), [d3-geo](https://github.com/d3/d3-geo) (ISC, build-time only).
