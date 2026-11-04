// ---------------------------------------------------------------------------
// Palette — the single place colors live.
//
// Everything visual pulls from here so colors are easy to tune in one spot, and
// so we can build real palette/theming/semantic-color logic on top of it later
// (color will carry meaning: locus identity, grouping, provenance, ...).
// ---------------------------------------------------------------------------

// Fixed UI colors (the "paper and pencil" surface, plus chrome).
export const palette = {
  paper: "#faf0d4", //      canvas + minimap background
  toolbar: "#8fb084", //    top toolbar + sidebar background
  accent: "#f5efda", //     accents: map-list highlight, tool/button names
  knob: "#a77ec4", //       the sidebar collapse circle
  danger: "#e87f6f", //     destructive actions (delete locus)
  pathClosed: "#b0aaba", // connection lines into a closed locus (retracted) — light, easy to tell apart at a distance
  ink: "#333333", //        outlines + labels (the pencil)
  inkSoft: "#33333355", //  faint card borders
  hud: "#555555", //        secondary text
  locusBody: "#ffffff", //  fill of a locus circle
  windowDim: "#cccccc", //  unlit windows (locus closed)
  cardDefault: "#c9c4ba", // a card with no locus (neutral until a locus catches it)
};

// Colors handed out to loci, in order. These are the identities that cards
// inherit, so they're kept separate from the fixed UI colors above.
export const locusColors = [
  "#cc88aa", // rose
  "#7cb38a", // green
  "#7aa2c8", // blue
  "#d6a45c", // amber
  "#9b8bc4", // violet
  "#5fb0a8", // teal
];

/** Pick a locus color by index, cycling if there are more loci than colors. */
export function locusColor(i: number): string {
  return locusColors[((i % locusColors.length) + locusColors.length) % locusColors.length];
}
