// The natural history of the solar system as a list of dated milestones, plus
// helpers for naming eras and formatting times.
//
// `needs` says what must still be true for a milestone to happen once the
// player has started meddling:
//   always    – happens regardless (the Sun's own evolution, the wider galaxy)
//   pristine  – a chance event; any earlier change to the system averts it
//   earth     – Earth must still exist and not have been resurfaced
//   life      – Earth must have stayed habitable the whole time
//   <body id> – that body must still be there
import { T_START, T_END, NOW_CE } from './constants.js';
import { SUN_T, sunPhase, SUN_PHASE_NAMES } from './sun.js';
import { T_GIANT_IMPACT, T_INSTABILITY, T_DISC_GONE } from './bodies.js';

const GYR = 1e9, MYR = 1e6;

export const NATURAL_EVENTS = [
  { id: 'nebula', view: 'system', t: T_START, rank: 3, kind: 'formation', focus: 'sun', needs: 'always', title: 'The solar nebula collapses',
    text: 'A cloud of gas and dust falls in on itself. The first solids condense around a newborn protostar wrapped in a spinning disc.' },
  { id: 'jupiter-core', t: T_START + 1.0 * MYR, rank: 2, kind: 'formation', focus: 'jupiter', needs: 'always', title: 'Jupiter\'s core forms',
    text: 'Beyond the snow line, ice and rock build a ten-Earth-mass core in under a million years — fast enough to start hoarding gas.' },
  { id: 'gas-giants', t: T_START + 3.2 * MYR, rank: 2, kind: 'formation', focus: 'jupiter', needs: 'always', title: 'Jupiter and Saturn swallow the gas',
    text: 'Runaway accretion: Jupiter balloons to 318 Earth masses and opens a gap in the disc. Saturn follows.' },
  { id: 'disc-gone', view: 'system', t: T_DISC_GONE, rank: 2, kind: 'formation', focus: 'sun', needs: 'always', title: 'The gas disc blows away',
    text: 'The young Sun\'s wind and ultraviolet light clear the remaining gas. Planet building continues with rock and ice alone.' },
  { id: 'instability', view: 'system', t: T_INSTABILITY, rank: 3, kind: 'formation', focus: 'saturn', needs: 'always', title: 'The giant planets migrate',
    text: 'Freed from the gas, the giants\' compact orbits go unstable. Jupiter edges inward; Saturn, Uranus and Neptune spread outward, scattering the outer belt of icy bodies.' },
  { id: 'zams', t: SUN_T.zams, rank: 3, kind: 'sun', focus: 'sun', needs: 'always', title: 'The Sun ignites',
    text: 'Core hydrogen fusion takes over. The Sun settles onto the main sequence at 70% of today\'s brightness.' },
  { id: 'theia', lead: 1.5, dist: 0.004, rate: 1 / 12, t: T_GIANT_IMPACT, rank: 3, kind: 'formation', focus: 'earth', needs: 'always', title: 'Theia strikes Earth — the Moon is born',
    text: 'A Mars-sized world sharing Earth\'s orbit collides with the proto-Earth. Debris flung into orbit gathers into the Moon within centuries, a tenth of its present distance away.' },
  { id: 'oceans', t: -4.40 * GYR, rank: 2, kind: 'earth', focus: 'earth', needs: 'earth', title: 'Earth\'s first oceans',
    text: 'The magma ocean has crusted over and steam rains out. Zircon crystals this old already record liquid water.' },
  { id: 'lhb', t: -3.95 * GYR, rank: 2, kind: 'formation', focus: 'moon', needs: 'always', title: 'Late heavy bombardment',
    text: 'The tail end of planet building: leftover bodies gouge the great basins of the Moon. (How sharp this spike was is still debated.)' },
  { id: 'venus-dry', t: -3.9 * GYR, rank: 1, kind: 'planet', focus: 'venus', needs: 'venus', title: 'Venus loses its water',
    text: 'Too close to the Sun to hold on to its seas, Venus tips into a runaway greenhouse. (The timing is highly uncertain.)' },
  { id: 'life', t: -3.7 * GYR, rank: 3, kind: 'life', focus: 'earth', needs: 'life', title: 'Earliest traces of life',
    text: 'Microbes leave chemical fingerprints in Greenland rocks; stromatolite reefs follow.' },
  { id: 'mars-dry', t: -3.5 * GYR, rank: 2, kind: 'planet', focus: 'mars', needs: 'mars', title: 'Mars dries out',
    text: 'With its magnetic field gone and its air leaking to space, Mars\'s rivers and lakes freeze or evaporate.' },
  { id: 'maria', t: -3.3 * GYR, rank: 1, kind: 'planet', focus: 'moon', needs: 'moon', title: 'The Moon\'s dark seas flood',
    text: 'Basalt wells up into the giant impact basins, painting the face we see today.' },
  { id: 'continents', t: -3.0 * GYR, rank: 2, kind: 'earth', focus: 'earth', needs: 'earth', title: 'Continents emerge',
    text: 'Plate tectonics is under way and stable cratons — the cores of future continents — rise above the sea.' },
  { id: 'goe', t: -2.4 * GYR, rank: 3, kind: 'life', focus: 'earth', needs: 'life', title: 'The Great Oxidation',
    text: 'Cyanobacteria flood the air with oxygen. Iron rusts out of the oceans, methane haze clears, and the sky turns blue.' },
  { id: 'huronian', t: -2.35 * GYR, rank: 2, kind: 'earth', focus: 'earth', needs: 'life', title: 'First Snowball Earth',
    text: 'With its methane blanket destroyed, Earth freezes almost to the equator for the first time.' },
  { id: 'nuna', t: -1.8 * GYR, rank: 1, kind: 'earth', focus: 'earth', needs: 'earth', title: 'Supercontinent Nuna',
    text: 'The scattered cratons weld together into the first well-documented supercontinent.' },
  { id: 'rodinia', t: -1.0 * GYR, rank: 2, kind: 'earth', focus: 'earth', needs: 'earth', title: 'Supercontinent Rodinia',
    text: 'Nearly all land is gathered into one barren mass.' },
  { id: 'cryogenian', t: -717 * MYR, rank: 2, kind: 'earth', focus: 'earth', needs: 'life', title: 'Snowball Earth',
    text: 'Rodinia breaks up, CO₂ plummets, and ice sheets reach the tropics — twice — over 80 million years.' },
  { id: 'cambrian', t: -539 * MYR, rank: 3, kind: 'life', focus: 'earth', needs: 'life', title: 'Cambrian explosion',
    text: 'Animals with shells, eyes and limbs appear in a geological instant.' },
  { id: 'plants', t: -470 * MYR, rank: 2, kind: 'life', focus: 'earth', needs: 'life', title: 'Plants colonise the land',
    text: 'The continents, bare rock for four billion years, begin to turn green.' },
  { id: 'pangaea', t: -320 * MYR, rank: 3, kind: 'earth', focus: 'earth', needs: 'earth', title: 'Pangaea assembles',
    text: 'The continents collide into a single landmass stretching from pole to pole.' },
  { id: 'great-dying', t: -252 * MYR, rank: 2, kind: 'life', focus: 'earth', needs: 'life', title: 'The Great Dying',
    text: 'Siberian volcanism triggers the worst mass extinction on record; nine in ten marine species vanish.' },
  { id: 'breakup', t: -175 * MYR, rank: 2, kind: 'earth', focus: 'earth', needs: 'earth', title: 'Pangaea breaks apart',
    text: 'The Atlantic begins to open. The modern continents start drifting toward their present places.' },
  { id: 'rings', t: -100 * MYR, rank: 2, kind: 'planet', focus: 'saturn', needs: 'saturn', title: 'Saturn gains its rings',
    text: 'Cassini\'s measurements suggest the bright icy rings are young — perhaps a shredded moon or comet. (Their age is still argued over.)' },
  { id: 'chicxulub', t: -66 * MYR, rank: 3, kind: 'life', focus: 'earth', needs: 'pristine', title: 'Chicxulub impact',
    text: 'A ten-kilometre asteroid strikes the Yucatán. The non-avian dinosaurs are gone; mammals inherit the Earth.' },
  { id: 'antarctica', t: -34 * MYR, rank: 1, kind: 'earth', focus: 'earth', needs: 'earth', title: 'Antarctica freezes over',
    text: 'Isolated at the pole by a circling ocean current, Antarctica grows a permanent ice sheet.' },
  { id: 'humans', t: -3e5, rank: 2, kind: 'life', focus: 'earth', needs: 'pristine', title: 'Homo sapiens',
    text: 'One species of African ape starts to look up and wonder.' },
  { id: 'now', t: 0, rank: 3, kind: 'now', focus: 'earth', needs: 'always', title: 'Present day',
    text: 'You are here.' },
  { id: 'phobos', t: 40 * MYR, rank: 1, kind: 'planet', focus: 'mars', needs: 'mars', title: 'Phobos is torn apart',
    text: 'Spiralling inward, Mars\'s larger moon crosses the Roche limit and is shredded into a short-lived ring.' },
  { id: 'proxima', t: 250 * MYR, rank: 2, kind: 'earth', focus: 'earth', needs: 'earth', title: 'The next supercontinent',
    text: 'The Atlantic closes again and the continents reunite. (Its exact shape is a projection, not a prediction.)' },
  { id: 'rings-fade', t: 300 * MYR, rank: 1, kind: 'planet', focus: 'saturn', needs: 'saturn', title: 'Saturn\'s rings rain away',
    text: 'Dragged down by the planet\'s magnetic field, the last ring ice falls into Saturn.' },
  { id: 'photosynthesis', t: 600 * MYR, rank: 2, kind: 'life', focus: 'earth', needs: 'life', title: 'Photosynthesis begins to fail',
    text: 'A brightening Sun speeds up rock weathering, drawing down CO₂ until most plants can no longer survive.' },
  { id: 'triton', t: 3.6 * GYR, rank: 1, kind: 'planet', focus: 'neptune', needs: 'neptune', title: 'Triton falls toward Neptune',
    text: 'Neptune\'s backward-orbiting moon spirals inside the Roche limit and becomes a ring system to rival Saturn\'s.' },
  { id: 'andromeda', view: 'system', t: 4.5 * GYR, rank: 1, kind: 'sky', focus: 'sun', needs: 'always', title: 'Andromeda arrives',
    text: 'The Milky Way and Andromeda galaxies begin to merge. Stars are so far apart that the solar system almost certainly sails through untouched.' },
  { id: 'ms-end', t: SUN_T.msEnd, rank: 3, kind: 'sun', focus: 'sun', needs: 'always', title: 'The Sun runs out of core hydrogen',
    text: 'After ten billion years the main sequence ends. Fusion moves to a shell around an inert helium core and the Sun begins to swell.' },
  { id: 'red-giant', t: SUN_T.rgbStart, rank: 3, kind: 'sun', focus: 'sun', needs: 'always', title: 'The Sun becomes a red giant',
    text: 'Over the next 600 million years it will grow 250-fold and shine 2,700 times brighter, shedding a third of its mass.' },
  { id: 'helium-flash', t: SUN_T.rgbTip, rank: 3, kind: 'sun', focus: 'sun', needs: 'always', title: 'Helium flash',
    text: 'At 100 million kelvin the core ignites helium all at once. The Sun shrinks to a tenth of its peak size and burns steadily for another 100 million years.' },
  { id: 'agb', t: SUN_T.agbStart, rank: 2, kind: 'sun', focus: 'sun', needs: 'always', title: 'The Sun swells a second time',
    text: 'Core helium is spent. Twin burning shells make the Sun unstable; it pulses and bloats again.' },
  { id: 'nebula-end', lead: -2500, dist: 2.6e5, rate: 1000, t: SUN_T.agbTip, rank: 3, kind: 'sun', focus: 'sun', needs: 'always', title: 'The Sun sheds its outer layers',
    text: 'A final superwind blows the envelope into space. The exposed core lights it up as a planetary nebula for a few thousand years.' },
  { id: 'white-dwarf', view: 'system', t: SUN_T.agbTip + 5e4, rank: 3, kind: 'sun', focus: 'sun', needs: 'always', title: 'White dwarf',
    text: 'What remains is an Earth-sized ember of carbon and oxygen holding 54% of the Sun\'s mass. It will cool for trillions of years.' },
];

const PERIODS = [
  [539, 'Cambrian'], [485, 'Ordovician'], [444, 'Silurian'], [419, 'Devonian'], [359, 'Carboniferous'], [299, 'Permian'],
  [252, 'Triassic'], [201, 'Jurassic'], [145, 'Cretaceous'], [66, 'Paleogene'], [23, 'Neogene'], [2.58, 'Quaternary'],
];

/** Geological / stellar era name for a time. */
export function eraName(t) {
  if (t < T_START + 5 * MYR) return 'Solar nebula';
  if (t < -4.0 * GYR) return 'Hadean eon';
  if (t < -2.5 * GYR) return 'Archean eon';
  if (t < -539 * MYR) return 'Proterozoic eon';
  if (t < -11700) {
    const ma = -t / MYR;
    let name = 'Cambrian';
    for (const [start, n] of PERIODS) if (ma <= start) name = n;
    return `${name} period`;
  }
  if (t < 12000) return 'Holocene';
  const ph = sunPhase(t);
  if (ph === 'main-sequence') return t < 1.1 * GYR ? 'Future' : 'Late main-sequence Sun';
  return `${SUN_PHASE_NAMES[ph]} Sun`.replace('star Sun', 'Sun').replace('nucleus Sun', 'phase');
}

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function sig(x, digits) {
  return x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/**
 * Human-readable time. `step` is the size of time change that matters right
 * now (e.g. years advanced per second of playback) and sets the precision.
 */
export function formatTime(t, step = 1e6) {
  const a = Math.abs(t);
  if (a < step * 0.02 && step >= 200) return 'Present day';
  if (a < 6000 && step < 200) {
    const year = NOW_CE + t;
    if (step < 0.3) {
      const y = Math.floor(year);
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const ms = Date.UTC(2000, 0, 1) + (year - y) * (leap ? 366 : 365) * 864e5;
      const d = new Date(ms);
      d.setUTCFullYear(Math.max(1, y));
      const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      const clock = step < 0.002 ? ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '';
      return y > 0 ? `${day} ${y}${clock}` : `${day} ${1 - y} BCE${clock}`;
    }
    const y = Math.round(year);
    return y > 0 ? `${y} CE` : `${1 - y} BCE`;
  }
  const dir = t < 0 ? ' ago' : ' from now';
  const prec = (unit) => Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.max(step, 1e-9) / unit)) + 1));
  if (a >= 1e9) return `${sig(a / 1e9, Math.max(2, prec(1e9)))} billion years${dir}`;
  if (a >= 1e6) return `${sig(a / 1e6, Math.max(a >= 1e8 ? 0 : 1, prec(1e6)))} million years${dir}`;
  if (a >= 1e4) return `${sig(a / 1e3, Math.max(0, prec(1e3)))} thousand years${dir}`;
  return `${sig(a, Math.max(0, Math.min(2, prec(1))))} years${dir}`;
}

/** Compact form for timeline ticks and event flags: "4.51 Ga", "66 Ma", "+1.1 Gyr". */
export function formatTimeShort(t) {
  const a = Math.abs(t);
  const trim = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1).replace(/\.0$/, '') : x.toFixed(2).replace(/\.?0+$/, ''));
  if (a < 0.5) return 'now';
  if (t < 0) {
    if (a >= 1e9) return `${trim(a / 1e9)} Ga`;
    if (a >= 1e6) return `${trim(a / 1e6)} Ma`;
    if (a >= 1e3) return `${trim(a / 1e3)} ka`;
    return `${trim(a)} yr ago`;
  }
  if (a >= 1e9) return `+${trim(a / 1e9)} Gyr`;
  if (a >= 1e6) return `+${trim(a / 1e6)} Myr`;
  if (a >= 1e3) return `+${trim(a / 1e3)} kyr`;
  return `+${trim(a)} yr`;
}

/** A duration such as "1.2 million years" (no direction). */
export function formatSpan(years) {
  const a = Math.abs(years);
  const trim = (x) => (x >= 100 ? nf0.format(x) : x >= 10 ? x.toFixed(1).replace(/\.0$/, '') : x.toFixed(2).replace(/\.?0+$/, ''));
  if (a >= 1e9) return `${trim(a / 1e9)} billion years`;
  if (a >= 1e6) return `${trim(a / 1e6)} million years`;
  if (a >= 1e3) return `${trim(a / 1e3)} thousand years`;
  if (a >= 1) return `${trim(a)} year${trim(a) === '1' ? '' : 's'}`;
  if (a >= 1 / 365.25) return `${trim(a * 365.25)} days`;
  if (a >= 1 / 8766) return `${trim(a * 8766)} hours`;
  return `${trim(a * 525960)} minutes`;
}

export { T_START, T_END };
