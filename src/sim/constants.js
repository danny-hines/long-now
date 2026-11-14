// Units throughout the simulation: AU, years, solar masses.
// In these units G = 4π² (Kepler's third law: P² = a³ for the Sun).
export const G = 4 * Math.PI * Math.PI;
export const TAU = 2 * Math.PI;
export const DEG = Math.PI / 180;

export const AU_KM = 149597870.7;
export const RSUN_AU = 695700 / AU_KM;
export const REARTH_AU = 6371 / AU_KM;
export const MEARTH = 3.0034896e-6; // solar masses
export const MJUP = 9.5479e-4;
export const KMS = 0.2109495; // 1 km/s in AU/yr
export const YEAR_S = 31557600;

// Timeline. t is in years relative to the present day (negative = past).
export const T_START = -4.568e9; // first solids condense in the solar nebula
export const T_END = 8.0e9; // the Sun is a cooling white dwarf
export const NOW_CE = 2026.87; // calendar year at t = 0
export const J2000_OFFSET = NOW_CE - 2000.0; // years from J2000 to t = 0

// A planet is swallowed once its perihelion dips inside this multiple of the
// solar radius: tidal drag pulls in anything orbiting just above the surface
// of a giant star (Schröder & Smith 2008 find Earth is lost this way).
export const ENGULF_FACTOR = 1.3;

// Interventions are allowed once the planets have finished assembling.
export const T_INTERVENE_MIN = -4.45e9;
