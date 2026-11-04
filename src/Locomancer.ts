import { palette } from "./palette";
import { type SpatialEntry, type Stroke, type Vec2, vec } from "./types";

// How easily each kind gets shoved when it is NOT pinned (smaller = heavier).
// Loci are landmarks: heavier, so they yield less than cards do. A loose
// (un-placed) card is light. Placing a card makes it heavier, so the ambient
// crowd yields to it and it holds its spot — but it still gives way to a card
// you actively drag in (that one is pinned, i.e. mass-zero, while held).
const LOCUS_INV_MASS = 0.35;
const CARD_INV_MASS = 1.0;
const CARD_PLACED_INV_MASS = 0.3;

/**
 * Locomancer — the single source of truth for WHERE everything is.
 *
 * It owns a registry of SpatialEntry rows, keyed by id. Locus and Card objects
 * (added later) describe *what* things are; the Locomancer tracks *where* they
 * sit and where they want to go, then hands that to Worldbuilder each frame.
 *
 * Today it only *tracks* positions. Later it will *compute* good targets with
 * NLP — but "computing" only ever means writing better values into `target`.
 * The engine never has to change.
 */
export class Locomancer {
  // id -> spatial row. A Map gives O(1) lookup by id and keeps insertion order.
  private entries = new Map<string, SpatialEntry>();

  // The lattice is a fine snap spacing (smaller than a card), NOT a slot grid.
  // Placing a card rounds its home to the nearest lattice node, which keeps
  // arrangements tidy and quantized while still allowing variable card sizes,
  // diagonals, and rings. Non-overlap is a separate job, handled by physics.
  private lattice: number;

  constructor(opts: { lattice?: number } = {}) {
    this.lattice = opts.lattice ?? 8;
  }

  // --- Registration --------------------------------------------------------

  /** Register a locus at a fixed map spot. Starts closed (unpinned). Backed by a
   *  preset image (`imageSrc`/`image`) OR hand-drawn `strokes` (center-relative). */
  addLocus(opts: { id: string; position: Vec2; radius: number; color: string; imageSrc?: string; image?: HTMLImageElement; strokes?: Stroke[] }) {
    this.entries.set(opts.id, {
      id: opts.id,
      kind: "locus",
      position: { ...opts.position },
      target: { ...opts.position }, // the locus's PLACED home; expansion is added on top
      pinned: false,
      active: true, //                 loci are always on the map
      open: false,
      expand: 0,
      radius: opts.radius,
      invMass: LOCUS_INV_MASS,
      color: opts.color,
      imageSrc: opts.imageSrc,
      image: opts.image,
      strokes: opts.strokes,
    });
  }

  /**
   * Register a card. With a `locusId` it belongs to that locus: inactive until
   * the locus opens, and it glows the locus's color. Without one it is
   * "homeless" — it lives in the world immediately, at `position`, in a neutral
   * color (until a locus later catches it).
   */
  addCard(opts: { id: string; locusId?: string; position?: Vec2; radius: number; halfW?: number; halfH?: number; color?: string }) {
    if (opts.locusId) {
      const locus = this.require(opts.locusId);
      // Default home is a ring slot expressed as an OFFSET from the locus, so the
      // card rides along whenever the locus moves (dragged or pushed by expansion).
      const offset = this.defaultOffset(locus, this.cardCount(opts.locusId), opts.radius);
      this.entries.set(opts.id, {
        id: opts.id,
        kind: "card",
        position: { x: locus.position.x + offset.x, y: locus.position.y + offset.y },
        target: { x: locus.position.x + offset.x, y: locus.position.y + offset.y }, // unused for housed cards
        homeOffset: offset,
        pinned: false,
        active: false, //                  hidden while the locus is closed
        radius: opts.radius,
        halfW: opts.halfW,
        halfH: opts.halfH,
        invMass: CARD_INV_MASS,
        color: opts.color ?? locus.color, // a card glows its locus's color
        locusId: opts.locusId,
      });
    } else {
      const pos = opts.position ?? { x: 0, y: 0 };
      this.entries.set(opts.id, {
        id: opts.id,
        kind: "card",
        position: { ...pos },
        target: { ...pos },
        pinned: false,
        active: true, //                   homeless cards are always in the world
        radius: opts.radius,
        halfW: opts.halfW,
        halfH: opts.halfH,
        invMass: CARD_INV_MASS,
        color: opts.color ?? palette.cardDefault,
      });
    }
  }

  // --- Deliberate acts (open / close / place) ------------------------------

  /** Open a locus: mark it open (it now pushes space open) and bloom its cards. */
  openLocus(id: string) {
    const locus = this.require(id);
    locus.open = true;

    let i = 0;
    for (const e of this.entries.values()) {
      if (e.kind !== "card" || e.locusId !== id) continue;
      e.active = true;
      // Reappear at the card's home (locus center + its offset) with a tiny
      // spiral nudge so collision has a push direction if two homes coincide.
      const seed = this.seed(i);
      const off = e.homeOffset ?? { x: 0, y: 0 };
      e.position = { x: locus.position.x + off.x + seed.x, y: locus.position.y + off.y + seed.y };
      i++;
    }
  }

  /** Close a locus: stop pushing space open and tuck its cards away again. */
  closeLocus(id: string) {
    const locus = this.require(id);
    locus.open = false;
    for (const e of this.entries.values()) {
      if (e.kind === "card" && e.locusId === id) e.active = false;
    }
  }

  /**
   * Place a card: set its HOME to `at`, snapped to the lattice. The card stays a
   * normal movable body (not pinned) — it eases to this home and springs back to
   * it after being jostled. This is the only way (today) a card's home gets set
   * deliberately; later the Locomancer may also propose homes via NLP.
   */
  placeCard(id: string, at: Vec2) {
    const card = this.require(id);
    if (card.locusId) {
      // Home stored RELATIVE to the locus, snapped to the lattice in its frame.
      const locus = this.require(card.locusId);
      card.homeOffset = this.snapVec({ x: at.x - locus.position.x, y: at.y - locus.position.y });
    } else {
      card.target = this.snapVec(at); // homeless: absolute world home
    }
    card.invMass = CARD_PLACED_INV_MASS; // heavier now, so the crowd yields to it
  }

  /**
   * Move a locus to a new spot (used while dragging). Sets both its live position
   * and its placed home, and carries its active cards rigidly by the same delta
   * so the whole cloud moves as one piece.
   */
  moveLocus(id: string, to: Vec2) {
    const locus = this.require(id);
    const dx = to.x - locus.position.x;
    const dy = to.y - locus.position.y;
    locus.position = { x: to.x, y: to.y };
    locus.target = { x: to.x, y: to.y };
    for (const e of this.entries.values()) {
      if (e.kind === "card" && e.locusId === id && e.active) {
        e.position.x += dx;
        e.position.y += dy;
      }
    }
  }

  // --- Access for Worldbuilder ---------------------------------------------

  /** Every entry currently in play (Worldbuilder reads these each frame). */
  activeEntries(): SpatialEntry[] {
    const out: SpatialEntry[] = [];
    for (const e of this.entries.values()) if (e.active) out.push(e);
    return out;
  }

  get(id: string): SpatialEntry | undefined {
    return this.entries.get(id);
  }

  /** Live card entries belonging to a locus (including inactive ones). */
  cardsOf(locusId: string): SpatialEntry[] {
    const out: SpatialEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.kind === "card" && e.locusId === locusId) out.push(e);
    }
    return out;
  }

  // --- serialization (for saving / switching maps) -------------------------

  /** Plain, JSON-safe copy of every entry (drops the resolved Image; keeps src). */
  export(): SpatialEntry[] {
    const out: SpatialEntry[] = [];
    for (const e of this.entries.values()) {
      const { image: _image, highlight: _highlight, ...rest } = e;
      out.push({ ...rest, position: { ...e.position }, target: { ...e.target } });
    }
    return out;
  }

  /** Replace all entries from a saved set; `resolveImage` rehydrates locus drawings. */
  load(entries: SpatialEntry[], resolveImage: (src?: string) => HTMLImageElement | undefined) {
    this.entries.clear();
    for (const e of entries) {
      const copy: SpatialEntry = { ...e, position: { ...e.position }, target: { ...e.target } };
      if (copy.kind === "locus") copy.image = resolveImage(copy.imageSrc);
      this.entries.set(copy.id, copy);
    }
  }

  /** Remove everything (e.g. before loading a different map). */
  clear() {
    this.entries.clear();
  }

  /** Remove an entry entirely (e.g. deleting a card). */
  remove(id: string) {
    this.entries.delete(id);
  }

  /** Put a previously-removed entry back (for undo of a delete). */
  restore(entry: SpatialEntry) {
    this.entries.set(entry.id, entry);
  }

  /** Capture the mutable spatial fields of an entry (for undo of a move/assign). */
  snapshot(id: string) {
    const e = this.require(id);
    return {
      position: { ...e.position },
      target: { ...e.target },
      homeOffset: e.homeOffset ? { ...e.homeOffset } : undefined,
      locusId: e.locusId,
      invMass: e.invMass,
      active: e.active,
      color: e.color,
    };
  }

  /** Restore fields captured by snapshot(). */
  applySnapshot(id: string, s: ReturnType<Locomancer["snapshot"]>) {
    const e = this.entries.get(id);
    if (!e) return;
    e.position = { ...s.position };
    e.target = { ...s.target };
    e.homeOffset = s.homeOffset ? { ...s.homeOffset } : undefined;
    e.locusId = s.locusId;
    e.invMass = s.invMass;
    e.active = s.active;
    e.color = s.color;
  }

  /** The locus whose circle contains a world point (for drag-to-assign), if any. */
  locusAtPoint(p: Vec2): SpatialEntry | null {
    for (const e of this.entries.values()) {
      if (e.kind !== "locus") continue;
      if (Math.hypot(p.x - e.position.x, p.y - e.position.y) <= e.radius) return e;
    }
    return null;
  }

  /** Mark exactly one locus as the catch candidate (or none). */
  setHighlightedLocus(id: string | null) {
    for (const e of this.entries.values()) {
      if (e.kind === "locus") e.highlight = e.id === id;
    }
  }

  /**
   * Assign a card to a locus: it adopts the locus's color and becomes one of its
   * cards. Dropped onto an OPEN locus, it stays where you put it (placed) and
   * joins the bloom; dropped onto a CLOSED locus, it tucks inside (inactive) with
   * a default ring slot to bloom to when the locus next opens.
   */
  assignCard(cardId: string, locusId: string, at?: Vec2) {
    const card = this.require(cardId);
    const locus = this.require(locusId);
    card.locusId = locusId;
    card.color = locus.color;
    card.invMass = CARD_INV_MASS;
    const slot = () => this.defaultOffset(locus, this.cardCount(locusId) - 1, card.radius);
    if (locus.open) {
      card.active = true;
      // Keep where you dropped it (as an offset), else a default ring slot.
      card.homeOffset = at ? this.snapVec({ x: at.x - locus.position.x, y: at.y - locus.position.y }) : slot();
    } else {
      card.active = false;
      card.homeOffset = slot();
    }
  }

  /**
   * Detach a card from its locus → homeless, placed in the world at `at`. The
   * inverse of assignCard (used by ⌘-drag): neutral color, no locus, an absolute
   * world home. A distinct act from placeCard, which keeps the card owned.
   */
  detachCard(cardId: string, at: Vec2) {
    const card = this.require(cardId);
    card.locusId = undefined;
    card.homeOffset = undefined;
    card.color = palette.cardDefault;
    card.active = true;
    card.invMass = CARD_PLACED_INV_MASS;
    card.target = this.snapVec(at); // homeless: absolute world home
  }

  // --- internals -----------------------------------------------------------

  private require(id: string): SpatialEntry {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Locomancer: no entry with id "${id}"`);
    return e;
  }

  /** Round a vector's components to the nearest lattice node. */
  private snapVec(v: Vec2): Vec2 {
    const L = this.lattice;
    return { x: Math.round(v.x / L) * L, y: Math.round(v.y / L) * L };
  }

  /**
   * How far an OPEN locus's cards actually reach from its center, measured per
   * direction (left/right/up/down) — the *edge* of the farthest card on each
   * side. Worldbuilder uses these to insert space only where cards really are.
   */
  cloudExtents(locusId: string): { l: number; r: number; u: number; d: number } {
    let l = 0;
    let r = 0;
    let u = 0;
    let d = 0;
    for (const e of this.entries.values()) {
      if (e.kind !== "card" || e.locusId !== locusId || !e.active || !e.homeOffset) continue;
      const ox = e.homeOffset.x;
      const oy = e.homeOffset.y;
      const hw = e.halfW ?? e.radius;
      const hh = e.halfH ?? e.radius;
      // The cloud's bounding box: how far any card's edge reaches each direction.
      r = Math.max(r, ox + hw);
      l = Math.max(l, -ox + hw);
      d = Math.max(d, oy + hh);
      u = Math.max(u, -oy + hh);
    }
    return { l: Math.max(0, l), r: Math.max(0, r), u: Math.max(0, u), d: Math.max(0, d) };
  }

  /** How many cards already belong to a locus (used to index sunflower slots). */
  private cardCount(locusId: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.kind === "card" && e.locusId === locusId) n++;
    }
    return n;
  }

  /**
   * A distinct default home OFFSET (relative to the locus center) for card #idx:
   * tidy concentric rings. Fill the innermost ring with as many evenly-spaced
   * slots as its circumference allows, then the next ring out, and so on.
   * Alternate rings are staggered by half a slot so cards don't form spokes.
   */
  private defaultOffset(locus: SpatialEntry, idx: number, cardRadius: number): Vec2 {
    const spacing = cardRadius * 2.4; //   arc distance between neighbors on a ring
    const shellStep = cardRadius * 2.4; // radial distance between rings
    let rest = idx;
    let ring = 0;
    while (true) {
      const r = locus.radius + cardRadius + ring * shellStep;
      const slots = Math.max(1, Math.floor((2 * Math.PI * r) / spacing));
      if (rest < slots) {
        const stagger = (ring % 2) * (Math.PI / slots); // offset every other ring
        const angle = (rest / slots) * 2 * Math.PI + stagger;
        return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
      }
      rest -= slots; // this card lives further out; move to the next ring
      ring++;
    }
  }

  /** Deterministic tiny spiral offset for card #i (no randomness). */
  private seed(i: number): Vec2 {
    const golden = 2.399963; // ~137.5°, the golden angle — spreads points evenly
    const a = i * golden;
    const r = 2 + i * 1.5;
    return vec(Math.cos(a) * r, Math.sin(a) * r);
  }
}
