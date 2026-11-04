import { Locomancer } from "./Locomancer";
import { measureContentBox, type ContentBox } from "./imageCrop";
import { drawStroke } from "./ink";
import { palette } from "./palette";
import type { SpatialEntry } from "./types";

export interface WorldConfig {
  attraction: number; // 0..1 — how far toward its target each body eases per frame
  iterations: number; // collision relaxation passes per frame
  padding: number; //   extra gap kept between bodies (the literal "slack")
  stiffness: number; // 0..1 — fraction of each overlap corrected per pass.
  //                    < 1 is "under-relaxation": it damps the overshoot that
  //                    makes crowded packings jitter and swap back and forth.
}

const DEFAULTS: WorldConfig = { attraction: 0.2, iterations: 10, padding: 10, stiffness: 0.7 };

// If a movable body moves less than this (px) over a WHOLE frame, we treat it
// as settled and snap it back to where it started — so a cloud that has come to
// rest goes truly static instead of creeping/rotating forever.
const SLEEP_DIST = 0.08;

// How fast a locus's expansion animates toward open (1) or closed (0) per frame.
const EXPAND_EASE = 0.18;

// Locus layout: gentle spring back to placed home (location preference), and a
// FULL-strength footprint separation so clouds never overlap — separation always
// wins over the spring. LOCUS_GAP is the clear space kept between two clouds.
const LOCUS_SPRING = 0.15;
const LOCUS_ITERATIONS = 10;
const LOCUS_STIFFNESS = 1.0;
const LOCUS_GAP = 24;

/**
 * Worldbuilder — owns MOTION and DRAWING.
 *
 * Each frame the harness calls step() then render(). Worldbuilder reads the
 * Locomancer's registry, eases each body toward its target, resolves overlaps,
 * and writes the results back into `position`. It is the ONLY thing that moves
 * anything. It knows nothing about meaning — only circles, squares, and forces.
 */
export class Worldbuilder {
  cfg: WorldConfig;

  // Each drawing's content box, measured once and cached.
  private contentBoxes = new WeakMap<HTMLImageElement, ContentBox | null>();
  // Each drawing pre-scaled (cropped) to a small canvas, so we don't rescale the
  // full 2048² source every frame — the main pan/zoom cost.
  private baked = new WeakMap<HTMLImageElement, HTMLCanvasElement | null>();

  constructor(private loco: Locomancer, cfg: Partial<WorldConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  private contentBox(img: HTMLImageElement): ContentBox | null {
    const cached = this.contentBoxes.get(img);
    if (cached !== undefined) return cached; // null is a valid cached result
    const box = measureContentBox(img);
    this.contentBoxes.set(img, box);
    return box;
  }

  /** The drawing cropped + pre-scaled to a small canvas (~512px), cached per image. */
  private bake(img: HTMLImageElement): HTMLCanvasElement | null {
    const cached = this.baked.get(img);
    if (cached !== undefined) return cached;
    const crop = this.contentBox(img);
    const sx = crop ? crop.sx : 0;
    const sy = crop ? crop.sy : 0;
    const sw = crop ? crop.sw : img.naturalWidth;
    const sh = crop ? crop.sh : img.naturalHeight;
    const BAKE = 512;
    const scale = BAKE / Math.max(sw, sh);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    if (!g) {
      this.baked.set(img, null);
      return null;
    }
    g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    this.baked.set(img, c);
    return c;
  }

  /** Advance the simulation one frame. This is the whole physics. */
  step() {
    // PHASE 0 — LOCI: spring each locus toward its placed home, then push apart
    // any two locus+cloud footprints that would overlap. Pushed loci carry
    // their clouds rigidly, so cards never rearrange just because a locus moved.
    this.locusStep();

    const bodies = this.loco.activeEntries();
    const cards = bodies.filter((b) => b.kind === "card");
    const n = bodies.length;

    // Remember where each card started this frame (for the SLEEP check below).
    const start = cards.map((b) => ({ x: b.position.x, y: b.position.y }));

    // PHASE 1 — ATTRACTION: ease each card toward its HOME. A housed card's home
    // is its locus's center plus its offset (so it tracks the moving locus);
    // a homeless card's home is its absolute target. Loci are positioned in
    // phase 0, so they are skipped here.
    const k = this.cfg.attraction;
    for (const b of cards) {
      if (b.pinned) continue; // a dragged card is under the user's hand
      const home = this.homeOf(b);
      b.position.x += k * (home.x - b.position.x);
      b.position.y += k * (home.y - b.position.y);
    }

    // PHASE 2 — CONTACT: forbid overlaps. Several relaxation passes, because
    // pushing pair A-B apart can create a new overlap B-C; repeating lets the
    // displacement ripple outward through contact until it settles.
    //
    // We ALTERNATE the sweep direction each pass. Always walking pairs in the
    // same order gives the earlier bodies a permanent bias, and in a dense ring
    // that bias accumulates into a slow rotation. Flipping the order each pass
    // cancels it.
    for (let pass = 0; pass < this.cfg.iterations; pass++) {
      if (pass % 2 === 0) {
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) this.resolve(bodies[i], bodies[j]);
      } else {
        for (let i = n - 1; i >= 0; i--) for (let j = n - 1; j > i; j--) this.resolve(bodies[i], bodies[j]);
      }
    }

    // PHASE 3 — SLEEP: if a card barely moved over the whole frame, it has
    // settled — snap it back to its start so a cloud at rest goes truly static.
    for (let i = 0; i < cards.length; i++) {
      const b = cards[i];
      if (b.pinned) continue;
      const dx = b.position.x - start[i].x;
      const dy = b.position.y - start[i].y;
      if (dx * dx + dy * dy < SLEEP_DIST * SLEEP_DIST) {
        b.position.x = start[i].x;
        b.position.y = start[i].y;
      }
    }
  }

  /**
   * Lay out the loci. Each locus springs toward its placed home; then any two
   * locus+cloud footprints that would overlap are pushed apart. A pushed locus
   * carries its cards rigidly, so opening a locus shoves its neighbours (and
   * their clouds) aside to make room, and closing lets them spring back.
   */
  private locusStep() {
    const loci: SpatialEntry[] = [];
    for (const e of this.loco.activeEntries()) if (e.kind === "locus") loci.push(e);

    // Animate each locus's expansion (footprint size) toward open(1)/closed(0).
    for (const h of loci) {
      const goal = h.open ? 1 : 0;
      h.expand = (h.expand ?? 0) + EXPAND_EASE * (goal - (h.expand ?? 0));
    }

    // Spring toward the placed home (skips the one being dragged). This is what
    // returns shoved loci to their spots once a neighbour closes.
    for (const h of loci) {
      if (h.pinned) continue;
      this.moveLocusBy(h, LOCUS_SPRING * (h.target.x - h.position.x), LOCUS_SPRING * (h.target.y - h.position.y));
    }

    // Push apart overlapping footprints, a few relaxation passes (alternating).
    const n = loci.length;
    for (let pass = 0; pass < LOCUS_ITERATIONS; pass++) {
      if (pass % 2 === 0) {
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) this.resolveFootprints(loci[i], loci[j]);
      } else {
        for (let i = n - 1; i >= 0; i--) for (let j = n - 1; j > i; j--) this.resolveFootprints(loci[i], loci[j]);
      }
    }
  }

  /** Move a locus and carry its active cards by the same delta (rigid cloud). */
  private moveLocusBy(h: SpatialEntry, dx: number, dy: number) {
    if (dx === 0 && dy === 0) return;
    h.position.x += dx;
    h.position.y += dy;
    for (const c of this.loco.activeEntries()) {
      if (c.kind === "card" && c.locusId === h.id) {
        c.position.x += dx;
        c.position.y += dy;
      }
    }
  }

  /** A locus's footprint half-extent on each side: the drawing, grown to the cloud. */
  private footprint(h: SpatialEntry): { l: number; r: number; u: number; d: number } {
    const expand = h.expand ?? 0;
    const grow = (side: number) => h.radius + Math.max(0, side - h.radius) * expand;
    if (expand <= 0.001) return { l: h.radius, r: h.radius, u: h.radius, d: h.radius };
    const ext = this.loco.cloudExtents(h.id);
    return { l: grow(ext.l), r: grow(ext.r), u: grow(ext.u), d: grow(ext.d) };
  }

  /** Push two locus+cloud footprints apart along the axis of least overlap. */
  private resolveFootprints(a: SpatialEntry, b: SpatialEntry) {
    const fa = this.footprint(a);
    const fb = this.footprint(b);
    // Overlap of the two footprint boxes, plus a gap so clouds keep clear air.
    const ox = Math.min(a.position.x + fa.r, b.position.x + fb.r) - Math.max(a.position.x - fa.l, b.position.x - fb.l) + LOCUS_GAP;
    const oy = Math.min(a.position.y + fa.d, b.position.y + fb.d) - Math.max(a.position.y - fa.u, b.position.y - fb.u) + LOCUS_GAP;
    if (ox <= 0 || oy <= 0) return; // far enough apart already

    // Who yields: a dragged locus is fixed; an open locus anchors against a
    // closed one; two open loci split the move so their midpoint holds.
    let wa: number;
    let wb: number;
    if (a.pinned && b.pinned) return;
    else if (a.pinned) (wa = 0), (wb = 1);
    else if (b.pinned) (wa = 1), (wb = 0);
    else if (a.open && !b.open) (wa = 0), (wb = 1); // open anchors, closed yields
    else if (b.open && !a.open) (wa = 1), (wb = 0);
    else (wa = 0.5), (wb = 0.5); // both open, or both closed (propagation): split

    if (ox < oy) {
      const dir = a.position.x < b.position.x ? -1 : 1;
      const corr = ox * LOCUS_STIFFNESS;
      this.moveLocusBy(a, dir * corr * wa, 0);
      this.moveLocusBy(b, -dir * corr * wb, 0);
    } else {
      const dir = a.position.y < b.position.y ? -1 : 1;
      const corr = oy * LOCUS_STIFFNESS;
      this.moveLocusBy(a, 0, dir * corr * wa);
      this.moveLocusBy(b, 0, -dir * corr * wb);
    }
  }

  /** A card's current home in world space. */
  private homeOf(card: SpatialEntry): { x: number; y: number } {
    if (card.locusId && card.homeOffset) {
      const locus = this.loco.get(card.locusId);
      if (locus) return { x: locus.position.x + card.homeOffset.x, y: locus.position.y + card.homeOffset.y };
    }
    return card.target;
  }

  /** Push one pair apart if — and only if — they actually overlap. */
  private resolve(a: SpatialEntry, b: SpatialEntry) {
    // A card being dragged is "lifted off the board": pinned, under the user's
    // hand. It floats OVER loci (so it can be carried in and dropped) while
    // still shoving other cards aside. The only pinned card at any moment is the
    // one being dragged, so this also stops a dragged card from pushing a closed
    // locus away — which otherwise made the drop target physically unreachable.
    const liftedCard = (e: SpatialEntry) => e.kind === "card" && e.pinned;
    if ((a.kind === "locus" && liftedCard(b)) || (b.kind === "locus" && liftedCard(a))) return;

    // Card↔card uses a box (AABB), so rectangular cards don't overlap at corners.
    // Only cards of the SAME locus (or two homeless cards) collide — different
    // clouds are kept apart by their loci' footprints, so they never jostle.
    if (a.kind === "card" && b.kind === "card") {
      if (a.locusId === b.locusId) this.resolveBox(a, b);
      return;
    }

    // The collision normal: the vector between the two POSITIONS (not targets).
    const dx = b.position.x - a.position.x;
    const dy = b.position.y - a.position.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 1e-6) dist = 1e-6; // safety; the spiral seed normally prevents this

    const overlap = a.radius + b.radius + this.cfg.padding - dist;
    if (overlap <= 0) return; // not touching: slack absorbs it, nobody moves

    // Loci are immovable to cards (cards always flow AROUND them); a pinned
    // (dragged) card is immovable too. invMass 0 means "takes none of the push".
    const invA = a.kind === "locus" ? 0 : a.pinned ? 0 : a.invMass;
    const invB = b.kind === "locus" ? 0 : b.pinned ? 0 : b.invMass;
    const total = invA + invB;
    if (total === 0) return; // two anchors touching: neither yields

    const nx = dx / dist;
    const ny = dy / dist;
    // Correct only a FRACTION of the overlap per pass (under-relaxation). The
    // leftover is cleaned up by later passes/frames, but no single push
    // overshoots, so the back-and-forth swapping damps out.
    const corr = overlap * this.cfg.stiffness;
    a.position.x -= nx * corr * (invA / total);
    a.position.y -= ny * corr * (invA / total);
    b.position.x += nx * corr * (invB / total);
    b.position.y += ny * corr * (invB / total);
  }

  /** Box (AABB) separation for two cards: push apart along the axis of least overlap. */
  private resolveBox(a: SpatialEntry, b: SpatialEntry) {
    const pad = this.cfg.padding;
    const ahw = a.halfW ?? a.radius;
    const ahh = a.halfH ?? a.radius;
    const bhw = b.halfW ?? b.radius;
    const bhh = b.halfH ?? b.radius;

    const dx = b.position.x - a.position.x;
    const dy = b.position.y - a.position.y;
    const ox = ahw + bhw + pad - Math.abs(dx); // overlap along x
    const oy = ahh + bhh + pad - Math.abs(dy); // overlap along y
    if (ox <= 0 || oy <= 0) return; // boxes don't overlap

    const invA = a.pinned ? 0 : a.invMass;
    const invB = b.pinned ? 0 : b.invMass;
    const total = invA + invB;
    if (total === 0) return;

    // Resolve along whichever axis needs the smaller move.
    if (ox < oy) {
      const s = dx < 0 ? -1 : 1;
      const corr = ox * this.cfg.stiffness;
      a.position.x -= s * corr * (invA / total);
      b.position.x += s * corr * (invB / total);
    } else {
      const s = dy < 0 ? -1 : 1;
      const corr = oy * this.cfg.stiffness;
      a.position.y -= s * corr * (invA / total);
      b.position.y += s * corr * (invB / total);
    }
  }

  // --- drawing --------------------------------------------------------------
  // Pure canvas work. The harness sets the camera transform before calling.

  // Worldbuilder paints only loci now. Cards are real DOM elements layered
  // over the canvas (see CardLayer), positioned from the same Locomancer data.
  render(ctx: CanvasRenderingContext2D) {
    const bodies = this.loco.activeEntries();
    for (const b of bodies) if (b.kind === "locus") this.drawLocus(ctx, b);
  }

  private drawLocus(ctx: CanvasRenderingContext2D, e: SpatialEntry) {
    const open = e.open ?? false;
    const { x, y } = e.position;

    // Catch cue: a dashed ring while a dragged card is hovering to be dropped in.
    if (e.highlight) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, e.radius, 0, Math.PI * 2);
      ctx.setLineDash([10, 8]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = e.color;
      ctx.stroke();
      ctx.restore();
    }

    // If the locus has a loaded pencil drawing, render that. The image itself
    // never changes; "open" just adds a soft glow in the locus's color, cast
    // around the drawn (opaque) pixels via the canvas shadow.
    if (e.image && e.image.complete && e.image.naturalWidth > 0) {
      const baked = this.bake(e.image); // small cached canvas (cropped + pre-scaled)
      if (baked) {
        const box = e.radius * 2;
        const scale = box / Math.max(baked.width, baked.height);
        const dw = baked.width * scale;
        const dh = baked.height * scale;
        const dx = x - dw / 2;
        const dy = y - dh / 2;
        if (open) {
          // "open" just adds a soft glow in the locus color around the drawing.
          ctx.save();
          ctx.shadowColor = e.color;
          ctx.shadowBlur = 18;
          ctx.drawImage(baked, dx, dy, dw, dh);
          ctx.drawImage(baked, dx, dy, dw, dh); // again, to deepen the glow
          ctx.restore();
        } else {
          ctx.drawImage(baked, dx, dy, dw, dh);
        }
        return;
      }
    }

    // A hand-drawn (stroke-backed) locus: render its center-relative strokes at
    // the locus position. Like the image path, "open" just casts a soft glow in
    // the locus color around the ink.
    if (e.strokes && e.strokes.length > 0) {
      ctx.save();
      if (open) {
        ctx.shadowColor = e.color;
        ctx.shadowBlur = 18;
      }
      for (const s of e.strokes) drawStroke(ctx, s, x, y);
      ctx.restore();
      return;
    }

    // Fallback: the placeholder circle + windows (used before images existed).
    ctx.beginPath();
    ctx.arc(x, y, e.radius, 0, Math.PI * 2);
    ctx.fillStyle = palette.locusBody;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = palette.ink;
    ctx.stroke();

    // two windows that light up (fill with the locus's color) when open
    const w = e.radius * 0.32;
    const off = e.radius * 0.34;
    for (const sx of [-1, 1]) {
      const wx = x + sx * off - w / 2;
      const wy = y - off - w / 2;
      ctx.fillStyle = open ? e.color : palette.windowDim;
      ctx.fillRect(wx, wy, w, w);
      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = 1;
      ctx.strokeRect(wx, wy, w, w);
    }

    if (open) {
      // soft glow ring so an open locus reads as "active"
      ctx.beginPath();
      ctx.arc(x, y, e.radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = palette.ink;
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(e.id, x, y + e.radius * 0.4);
  }
}
