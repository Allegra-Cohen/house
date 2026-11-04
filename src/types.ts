// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------
// A point or an offset in world space. Just a plain object, so it is trivial
// to read in a debugger, log, and (later) save to JSON.
export type Vec2 = { x: number; y: number };

export const vec = (x: number, y: number): Vec2 => ({ x, y });

// Tiny pure helpers (they never mutate their inputs) so the physics math
// later reads the same way it would on paper.
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const length = (a: Vec2): number => Math.hypot(a.x, a.y);

// ---------------------------------------------------------------------------
// Ink — freehand vector strokes (defined here so both the InkLayer and a
// stroke-backed Locus can share the type). A stroke is a path of points plus a
// separable style; see src/ink.ts for the why (recolor/resize/brushes/edit).
// ---------------------------------------------------------------------------
export type StrokePoint = { x: number; y: number; p: number }; // p = ink intensity 0..1 (speed-derived; stands in for pressure)
export type StrokeStyle = { brush: string; color: string; width: number };
export type Stroke = { id: string; points: StrokePoint[]; style: StrokeStyle };

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------
export type Kind = "locus" | "card";

// One row in the Locomancer's spatial registry. This is the ONLY place
// coordinates live in the whole app. Locus/Card (added later) hold *meaning*;
// this holds *where* that meaning currently sits in the world.
export interface SpatialEntry {
  id: string;
  kind: Kind;

  // The three fields the entire physics rests on:
  position: Vec2; // where it IS right now   — only Worldbuilder writes this
  target: Vec2; //   where it WANTS to be (absolute) — loci & homeless cards
  pinned: boolean; // if true, collisions cannot move it (it is an anchor)

  // Housed cards express their home RELATIVE to their locus (an offset from the
  // locus center), not as an absolute point — so the cloud rides along whenever
  // the locus moves, whether dragged or shoved apart by another locus's cloud.
  // When set, this supersedes `target` for the card.
  homeOffset?: Vec2;

  // Is it currently part of the simulation / render?
  // A card inside a CLOSED locus is inactive: it exists, but isn't placed yet.
  active: boolean;

  // Loci only — open state and its animation:
  open?: boolean; //  is the locus expanded (windows lit, cloud shown, pushing space open)
  expand?: number; // 0..1 eased toward open?1:0, so space grows/shrinks smoothly

  // What the collision step needs:
  radius: number; //  collision circle (loci) / a card's reach for circle tests
  invMass: number; // "shove-ability" when NOT pinned. Smaller = heavier = moves less.
  halfW?: number; // cards: half width  — card↔card collision uses a box, not a circle
  halfH?: number; // cards: half height — so rectangular cards don't overlap at corners

  // Appearance + ownership:
  color: string;
  imageSrc?: string; //       loci only: the drawing's URL (serializable).
  image?: HTMLImageElement; // loci only: the resolved drawing (not serialized).
  // A locus is backed by EITHER a preset image (above) OR hand-drawn ink: strokes
  // stored RELATIVE to the locus center (like a card's homeOffset), so the drawing
  // rides along when the locus moves and can be stamped to the toolbar later.
  strokes?: Stroke[];
  highlight?: boolean; //     loci only: transient "about to catch a card" cue.
  locusId?: string; // cards only: the locus this card belongs to, if any.
  //                   A card with no locusId is "homeless" — it lives directly
  //                   in the world (e.g. a standalone note, or one not yet
  //                   assigned to a locus).
}
