import type { Vec2, Stroke, StrokePoint, StrokeStyle } from "./types";
export type { Stroke, StrokePoint, StrokeStyle } from "./types"; // re-export for existing importers

// ---------------------------------------------------------------------------
// Ink — freehand vector strokes drawn on the canvas. This is the raw material
// of the tool: you draw, and lasso a drawing to elevate it into a Locus. Until
// then ink is just marks in the world — movable, recolorable, erasable — that
// own nothing and aren't reusable (arrows, annotations, doodles).
//
// Strokes are VECTOR, not pixels: a path of points plus a separable `style`
// (the type lives in types.ts so a stroke-backed Locus can share it). That's
// what makes everything we want later cheap — recolor (change a field), resize
// (transform the points), different pens (dispatch on `style.brush`), edit-
// after-the-fact (the points survive). Loose ink lives in WORLD coordinates,
// like every other body, so the camera transform handles pan/zoom for free.
// ---------------------------------------------------------------------------

// Brushes. Each is a preset style; the renderer (drawStroke) dispatches on the
// `brush` name to give each a distinct look. They're differentiated by width /
// opacity / texture so they read clearly even WITHOUT pen pressure (Sidecar's
// pencil reports none). Adding a brush = add an entry here + a render branch.
// Two brushes, each modeled on a Procreate brush. The real textures (grain/shape)
// get stamped along the path once the assets arrive; for now these are procedural
// PLACEHOLDERS — pen is a crisp opaque line, pencil a grainy double-pass. `width`
// here is just a fallback; the live width comes from the nib-size picker.
export type BrushId = "pen" | "pencil";
export const BRUSHES: Record<BrushId, StrokeStyle> = {
  pen: { brush: "pen", color: "#333333", width: 4 }, //      Studio Pen — crisp opaque ink
  pencil: { brush: "pencil", color: "#333333", width: 4 }, // Grut P Middler — grain-textured graphite
};

// Fallback default; also the renderer's fallback for any legacy brush name.
export const DEFAULT_STYLE: StrokeStyle = BRUSHES.pen;

/** Axis-aligned bounds of a set of strokes (in whatever space their points use). */
export function strokeBounds(strokes: Stroke[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes)
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Draw one stroke, offset by (ox,oy). Loose ink passes 0,0; a stroke-backed
 *  Locus passes its center, so its center-relative strokes land in world space.
 *  Dispatches on the brush. Shared by the InkLayer and Worldbuilder so loose ink
 *  and locus-ink render identically. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, ox = 0, oy = 0): void {
  if (s.points.length < 2) return;
  const w = s.style.width;
  switch (s.style.brush) {
    case "pencil": // Pencil (Grut P Middler) — grain texture if loaded, else procedural
      drawPencil(ctx, s, ox, oy, w);
      break;
    default: // pen — Studio Pen (placeholder): crisp opaque line. Also the fallback
      // for any legacy brush name (old "ink"/"marker" strokes render as a clean line).
      strokePath(ctx, s, ox, oy, { width: w, alpha: 1 });
      break;
  }
}

// Trace a stroke's smooth (midpoint-quadratic) path into the current path,
// optionally jittered (deterministic, seeded by point coords). No stroke/fill —
// callers stroke it however they like (solid line, or with a grain pattern).
function tracePath(ctx: CanvasRenderingContext2D, s: Stroke, ox: number, oy: number, jx = 0, seed = 0): void {
  const pts = s.points;
  const off = (p: StrokePoint) =>
    jx
      ? { x: p.x + ox + jit(p.x + seed, p.y) * jx, y: p.y + oy + jit(p.y, p.x + seed) * jx }
      : { x: p.x + ox, y: p.y + oy };
  ctx.beginPath();
  const m = off(pts[0]);
  ctx.moveTo(m.x, m.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const c = off(pts[i]);
    const n = off(pts[i + 1]);
    ctx.quadraticCurveTo(c.x, c.y, (c.x + n.x) / 2, (c.y + n.y) / 2);
  }
  const l = off(pts[pts.length - 1]);
  ctx.lineTo(l.x, l.y);
}

// Stroke a path as a solid line (optional alpha + jitter).
function strokePath(
  ctx: CanvasRenderingContext2D,
  s: Stroke,
  ox: number,
  oy: number,
  opt: { width: number; alpha: number; jitter?: number; seed?: number },
): void {
  ctx.save();
  ctx.globalAlpha = opt.alpha;
  ctx.strokeStyle = s.style.color;
  ctx.lineWidth = opt.width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  tracePath(ctx, s, ox, oy, opt.jitter ?? 0, opt.seed ?? 0);
  ctx.stroke();
  ctx.restore();
}

// Pencil: stroke the path with the repeating grain pattern (real graphite), at an
// opacity set by the stroke's average TONE (speed-derived) — slow strokes lay down
// dark, fast strokes light. Overlapping strokes build up, like real shading. Falls
// back to a procedural jittered line until/without the grain asset.
function drawPencil(ctx: CanvasRenderingContext2D, s: Stroke, ox: number, oy: number, w: number): void {
  const pat = grainPatternFor(ctx);
  if (!pat) {
    strokePath(ctx, s, ox, oy, { width: Math.max(1, w * 0.9), alpha: 0.6, jitter: Math.max(0.5, w * 0.4), seed: 0 });
    strokePath(ctx, s, ox, oy, { width: Math.max(1, w * 0.6), alpha: 0.5, jitter: Math.max(0.9, w * 0.8), seed: 11.3 });
    return;
  }
  let tone = 0;
  for (const p of s.points) tone += p.p;
  tone /= s.points.length || 1;
  ctx.save();
  ctx.globalAlpha = 0.8 + 0.2 * tone; // dark by default (~loci PNGs): 0.8 (fast) … 1.0 (slow)
  ctx.strokeStyle = pat;
  ctx.lineWidth = w;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  tracePath(ctx, s, ox, oy);
  ctx.stroke();
  ctx.restore();
}

// Deterministic pseudo-random in ~[-1,1] from a 2D coordinate (stable per point).
function jit(x: number, y: number): number {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

// --- brush grain texture (a Procreate Grain.png) -------------------------------
// A recolored, downscaled grain: RGB = the brush color, alpha = the grain's
// luminance — so stroking a path with it as a repeating pattern lays the graphite
// texture into the line. Cached per ctx; `grainVersion` invalidates on recolor.
let grainCanvas: HTMLCanvasElement | null = null;
let grainVersion = 0;
const grainPatterns = new Map<CanvasRenderingContext2D, { v: number; pat: CanvasPattern }>();

export function setBrushGrain(img: HTMLImageElement, color = "#333333"): void {
  const SIZE = 96; // small tile so grain stays visible even in thin nibs
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext("2d");
  if (!g) return;
  g.drawImage(img, 0, 0, SIZE, SIZE);
  let data: ImageData;
  try {
    data = g.getImageData(0, 0, SIZE, SIZE);
  } catch {
    return; // tainted canvas — shouldn't happen for a same-origin asset
  }
  const px = data.data;
  const [r, gg, b] = hexToRgb(color);
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
    px[i] = r;
    px[i + 1] = gg;
    px[i + 2] = b;
    px[i + 3] = Math.round(255 * Math.pow(lum, 0.45)); // alpha from luminance (low gamma → dense, dark graphite)
  }
  g.putImageData(data, 0, 0);
  grainCanvas = c;
  grainVersion++;
  grainPatterns.clear();
}

function grainPatternFor(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (!grainCanvas) return null;
  const cached = grainPatterns.get(ctx);
  if (cached && cached.v === grainVersion) return cached.pat;
  const pat = ctx.createPattern(grainCanvas, "repeat");
  if (!pat) return null;
  grainPatterns.set(ctx, { v: grainVersion, pat });
  return pat;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((ch) => ch + ch).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Don't record a sample until the pen has travelled at least this far (world px)
// from the last one — keeps the point list lean without visibly faceting.
const MIN_STEP = 0.6;

// Each point's `p` is an ink-intensity (0..1), used as a stand-in for pressure
// (Sidecar doesn't transmit Apple Pencil pressure). It's derived from stroke
// SPEED: slow, deliberate strokes read dark (→1); quick sweeps read light (→0),
// for shading. TONE_SPEED_REF is the speed (world px/ms) that maps to fully light.
const TONE_SPEED_REF = 0.5;

export class InkLayer {
  private strokes: Stroke[] = [];
  private active: Stroke | null = null; // the stroke currently being drawn, if any
  private activeLastT = 0; //             timestamp of the last recorded sample (for speed)
  private nextId = 0;

  /** Begin a stroke at a world point (called on pointer-down in Draw mode). */
  begin(at: Vec2, style: StrokeStyle = DEFAULT_STYLE): void {
    this.active = {
      id: `ink-${this.nextId++}`,
      points: [{ x: at.x, y: at.y, p: 0.6 }], // a neutral start tone; speed fills the rest
      style: { ...style },
    };
    this.activeLastT = performance.now();
  }

  /** Append a world point to the in-progress stroke (pointer-move). */
  extend(at: Vec2): void {
    if (!this.active) return;
    const pts = this.active.points;
    const last = pts[pts.length - 1];
    const d = Math.hypot(at.x - last.x, at.y - last.y);
    if (d < MIN_STEP) return;
    const t = performance.now();
    const dt = Math.max(1, t - this.activeLastT); // ms (avoid /0)
    this.activeLastT = t;
    const speed = d / dt; // world px per ms
    const tone = Math.max(0, Math.min(1, 1 - speed / TONE_SPEED_REF)); // slow → dark
    pts.push({ x: at.x, y: at.y, p: tone });
  }

  /** Finish the active stroke and commit it. Returns its id (for undo), or null. */
  end(): string | null {
    const s = this.active;
    this.active = null;
    if (!s) return null;
    // A tap with no travel is a dot: duplicate the point a hair so it renders
    // (round caps turn a 2-point zero-length segment into a filled dot).
    if (s.points.length === 1) s.points.push({ ...s.points[0], x: s.points[0].x + 0.01 });
    this.strokes.push(s);
    return s.id;
  }

  /** Drop the in-progress stroke without committing (e.g. pointer cancel). */
  cancel(): void {
    this.active = null;
  }

  /** Remove a committed stroke by id (used by undo). */
  remove(id: string): Stroke | null {
    const i = this.strokes.findIndex((s) => s.id === id);
    if (i < 0) return null;
    return this.strokes.splice(i, 1)[0];
  }

  /** Re-add a removed stroke (used by redo-of-undo paths). */
  add(stroke: Stroke): void {
    this.strokes.push(stroke);
    this.bumpId(stroke.id);
  }

  /** Draw every committed stroke plus the in-progress one. Caller has already set
   *  the camera transform, so we render in raw world coordinates. */
  render(ctx: CanvasRenderingContext2D): void {
    for (const s of this.strokes) drawStroke(ctx, s);
    if (this.active) drawStroke(ctx, this.active);
  }

  // --- selection (the lasso reads/takes loose strokes) ---------------------

  /** Live committed strokes (read-only) — the lasso tests these for enclosure. */
  list(): readonly Stroke[] {
    return this.strokes;
  }

  /** Remove (and return) every loose stroke passing within `radius` of point `p` —
   *  whole-stroke erasing. Only touches loose ink, never cards or loci. */
  eraseAt(p: Vec2, radius: number): Stroke[] {
    const r2 = radius * radius;
    const hit: Stroke[] = [];
    this.strokes = this.strokes.filter((s) => {
      const touched = s.points.some((pt) => (pt.x - p.x) ** 2 + (pt.y - p.y) ** 2 <= r2);
      if (touched) hit.push(s);
      return !touched;
    });
    return hit;
  }

  /** Shift the given strokes by (dx,dy) in world space — moving a selected drawing. */
  translate(ids: string[], dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const set = new Set(ids);
    for (const s of this.strokes) {
      if (!set.has(s.id)) continue;
      for (const p of s.points) {
        p.x += dx;
        p.y += dy;
      }
    }
  }

  /** Remove and return several committed strokes by id (used when elevating ink
   *  into a Locus: the strokes leave loose ink and become the locus's drawing). */
  removeMany(ids: string[]): Stroke[] {
    const set = new Set(ids);
    const taken: Stroke[] = [];
    this.strokes = this.strokes.filter((s) => {
      if (set.has(s.id)) {
        taken.push(s);
        return false;
      }
      return true;
    });
    return taken;
  }

  // --- serialization (loose ink is part of a map) --------------------------

  /** Plain, JSON-safe copy of every committed stroke. */
  export(): Stroke[] {
    return this.strokes.map((s) => ({ id: s.id, style: { ...s.style }, points: s.points.map((p) => ({ ...p })) }));
  }

  /** Replace all strokes from a saved set (drops any in-progress stroke). */
  load(strokes: Stroke[]): void {
    this.strokes = strokes.map((s) => ({ id: s.id, style: { ...s.style }, points: s.points.map((p) => ({ ...p })) }));
    this.active = null;
    this.nextId = 0;
    for (const s of this.strokes) this.bumpId(s.id);
  }

  clear(): void {
    this.strokes = [];
    this.active = null;
  }

  /** Keep nextId ahead of any restored/loaded id so new strokes never collide. */
  private bumpId(id: string): void {
    const n = Number(id.split("-")[1]);
    if (Number.isFinite(n) && n >= this.nextId) this.nextId = n + 1;
  }
}
