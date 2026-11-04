# Physics & collision notes (Worldbuilder + Locomancer)

Documentation below is mostly Claudish.

Detailed reference for the two modules worth keeping. Everything else (CardLayer,
ConnectionLayer, storage, maps, sidebar, toolbar, undo, the Electron shell) is
disposable scaffolding. These notes are written so the physics can be rebuilt or
re-hosted even if the rest is thrown away.

This describes **current behaviour** as of end-of-session-2. The expansion model is
**not settled** — the user is rethinking it. The agreed *intent* is at the bottom
under "Design intent vs. implementation".

---

## 0. The split of responsibilities (the one rule that matters)

- **Locomancer** = *where things are and want to be.* It owns a registry of bodies
  (`SpatialEntry`) keyed by `id`. It sets `target` / `homeOffset` (intent), `pinned`,
  `active`, masses, colours; it does **no motion integration and no rendering**.
- **Worldbuilder** = *motion + locus drawing.* Each frame it reads the registry,
  moves bodies, and writes back `position`. It is the **only** writer of `position`.
  It knows nothing about meaning — only circles, boxes, and forces.

Contract: **Locomancer owns `target`/`homeOffset`; Worldbuilder owns `position`.**
The camera (pan/zoom) lives in the harness, not in either module. Worldbuilder draws
loci to a canvas; cards are drawn elsewhere (currently DOM) but **positioned by the
same registry**, so a card renderer just reads `entry.position` each frame.

Per frame the harness calls `world.step()` then `world.render(ctx)`.

---

## 1. The data model — `SpatialEntry`

One row per body. Both loci and cards are entries; `kind` distinguishes them.

```
SpatialEntry {
  id: string
  kind: "locus" | "card"

  position: Vec2     // where it IS now            — ONLY Worldbuilder writes
  target:   Vec2     // absolute home              — loci & homeless cards
  pinned:   boolean  // immovable + skips forces   — true ONLY while being dragged
  active:   boolean  // is it simulated/rendered    — cards of a closed locus are false

  // loci only:
  open?:     boolean // expanded (windows lit, cloud shown, pushes space)
  expand?:   number  // 0..1 animated toward (open?1:0); footprint size scales by this
  imageSrc?: string  // drawing URL (serializable)
  image?:    HTMLImageElement  // resolved drawing (NOT serialized)
  highlight?: boolean // transient "card hovering to be dropped here" cue

  // collision:
  radius:  number    // circle radius (loci; also card↔locus circle + ring layout)
  halfW?:  number    // card box half-width   (card↔card uses a BOX, not a circle)
  halfH?:  number    // card box half-height  (measured from the real DOM card)
  invMass: number    // shove-ability when NOT pinned; smaller = heavier = moves less

  // cards only:
  color:   string
  locusId?: string   // owning locus, or undefined = "homeless"
  homeOffset?: Vec2  // home RELATIVE to the locus center (supersedes `target`)
}
```

### Masses (Locomancer constants)
- `LOCUS_INV_MASS = 0.35` — loci are heavy (but note: in collision they're treated
  as **fully immovable to cards** anyway; see §4).
- `CARD_INV_MASS = 1.0` — a loose card is light.
- `CARD_PLACED_INV_MASS = 0.3` — once a card is *placed* (user dropped it), it gets
  heavier so the ambient crowd yields to it, yet it still gives way to a card being
  actively dragged in (that one is `pinned`, i.e. invMass 0).

### The key idea: a card's home is RELATIVE to its locus
A housed card stores `homeOffset` (a vector from the locus centre), **not** an absolute
point. Its world home is computed live as `locus.position + homeOffset`. This is what
makes a cloud ride along rigidly whenever its locus moves (drag, expansion, spring).
A **homeless** card (no `locusId`) uses absolute `target` instead.

### `pinned` means exactly one thing now: "being dragged"
Earlier `pinned` also meant "open locus". That was split out: open-ness is the `open`
flag; `pinned` is **only** set true while the user drags a body (card or locus). A
pinned body skips attraction/spring and is immovable in collision.

### `active`
Loci are always `active`. A card is `active` only when it's loose (homeless) or its
locus is open. Closed-locus cards are `active:false` — not simulated, not rendered.
`Locomancer.activeEntries()` is what Worldbuilder iterates.

---

## 2. The frame loop — `Worldbuilder.step()`

Four phases, in order:

```
step():
  locusStep()                      // PHASE 0 — position loci (spring + footprint collision)
  cards = active cards
  start = snapshot of each card.position   // for SLEEP
  PHASE 1 — attraction: each non-pinned card eases toward homeOf(card)
  PHASE 2 — contact: `iterations` relaxation passes over ALL active pairs
  PHASE 3 — sleep: cards that barely moved this frame snap back to `start`
```

Loci are positioned entirely in phase 0 and are **immovable in phase 2**, so the
card phases never disturb them.

### Config (Worldbuilder `WorldConfig`, defaults)
- `attraction = 0.2` — fraction of the way a card eases toward home per frame.
- `iterations = 10` — card-collision passes per frame.
- `padding = 10` — extra gap kept between bodies in collision (the literal "slack").
- `stiffness = 0.7` — fraction of an overlap corrected per pass (**under-relaxation**;
  < 1 damps the overshoot that causes jitter / endless swapping).

### Module constants
- `SLEEP_DIST = 0.08` — per-frame movement below this ⇒ the card is "asleep".
- `EXPAND_EASE = 0.18` — how fast a locus's `expand` animates toward open/closed.
- Locus layout: `LOCUS_SPRING = 0.15`, `LOCUS_ITERATIONS = 10`,
  `LOCUS_STIFFNESS = 1.0` (full strength — separation must win over the spring),
  `LOCUS_GAP = 24` (clear air kept between two clouds).
- Locomancer `lattice = 8` — placement snap spacing.

---

## 3. PHASE 0 — loci (`locusStep`)

Loci are **not** moved by collision with cards. Their layout is its own system:

1. **Animate footprint size.** For each locus, ease `expand` toward `open ? 1 : 0`
   (`expand += EXPAND_EASE * (goal - expand)`). This makes space open/close smoothly.

2. **Spring toward placed home.** For each non-pinned locus, move it a fraction
   `LOCUS_SPRING` of the way from `position` toward `target` (its placed spot). This is
   the *location preference* and what springs a shoved locus back once its pusher
   closes. The move is applied via `moveLocusBy` (see below) so the cloud rides along.

3. **Separate overlapping footprints.** `LOCUS_ITERATIONS` relaxation passes,
   **alternating sweep direction** each pass (forward on even, backward on odd — this
   cancels the order-bias that otherwise makes dense arrangements creep/rotate). Each
   pass calls `resolveFootprints` on every locus pair.

### `moveLocusBy(h, dx, dy)` — rigid cloud carry
Moves the locus `position` by (dx,dy) **and** translates every active card with
`locusId === h.id` by the same delta. This is why cards never rearrange just because a
locus moved — the whole cloud is rigid under locus motion. (Card *homes* are relative
offsets, so attraction also wouldn't fight this; the explicit carry just removes lag.)

### `footprint(h)` — the locus+cloud bounding box, per side
Returns half-extents `{l, r, u, d}` (left/right/up/down distances from the locus
centre). Logic:
- If `expand <= 0.001` (effectively closed): footprint = the drawing, i.e. `radius` on
  all four sides.
- Otherwise grow each side from the drawing out to the cloud:
  `side = radius + max(0, cloudExtent_side - radius) * expand`
  where `cloudExtent_side` comes from `Locomancer.cloudExtents(h.id)` (§5). So as the
  locus opens, its footprint inflates from the drawing to enclose the whole cloud,
  per-direction (a one-sided cloud only inflates that side).

### `resolveFootprints(a, b)` — push two locus+cloud boxes apart
```
fa, fb = footprint(a), footprint(b)
ox = (x-overlap of the two boxes) + LOCUS_GAP    // +GAP ⇒ keep clear air, not just touch
oy = (y-overlap of the two boxes) + LOCUS_GAP
if ox <= 0 or oy <= 0: return                    // far enough apart already

// who yields (weights wa, wb that sum to 1):
if a.pinned && b.pinned: return                  // both dragged — leave them
elif a.pinned:           wa=0, wb=1              // dragged one is fixed
elif b.pinned:           wa=1, wb=0
elif a.open && !b.open:  wa=0, wb=1              // OPEN anchors, CLOSED yields
elif b.open && !a.open:  wa=1, wb=0
else:                    wa=0.5, wb=0.5          // both open OR both closed → split

// push along the axis of LEAST overlap (so the smaller correction wins):
if ox < oy:  move a by ±ox*LOCUS_STIFFNESS*wa in x, b oppositely by *wb
else:        same in y
direction = sign so they move apart (a goes to the side it's already on)
moves applied via moveLocusBy (cloud rides along)
```

Consequences of the weights:
- **Open vs closed:** the open locus holds its placed spot; the closed neighbour is
  shoved away. This is "opening a locus makes room by pushing neighbours out."
- **Both open:** 50/50 split → their midpoint holds (symmetric spreading).
- **Both closed:** also 50/50. This matters for **propagation**: when an open locus
  shoves a closed neighbour into *another* closed locus, that pair (both closed) also
  resolves, so the push travels down the line. Slack absorbs it (a pair already far
  enough apart has `ox/oy <= 0` and returns), so only loci that must move, move.
- `LOCUS_STIFFNESS = 1.0` + 10 passes ⇒ separation fully resolves each frame and thus
  **always beats the weaker spring** — clouds never end up overlapping. The spring only
  decides the resting spot, not whether overlap is allowed.

### Dragging a locus
The harness sets `pinned = true` and calls `Locomancer.moveLocus(id, worldPoint)` each
move (which sets `position` *and* `target` and carries active cards). Because it's
pinned, `locusStep` doesn't spring it and `resolveFootprints` treats it as fixed
(others yield around it) — so it tracks the cursor 1:1. On drop, `pinned = false` and
it re-enters the spring/collision system at its dropped `target`.

---

## 4. PHASES 1–2 — cards

### PHASE 1 — attraction
For each active, non-pinned card: `position += attraction * (home - position)` where
`home = homeOf(card)`:
- housed card → `locus.position + homeOffset`
- homeless card → `card.target`

That's the only place card homes are read. A pinned (dragged) card is skipped — it's
under the user's hand.

### PHASE 2 — contact (`resolve` per pair, with `iterations` alternating passes)
Iterates **all** active pairs (cards and loci), but the rules route each pair:

1. **Lifted card over a locus → skip.** If one body is a locus and the other is a
   *pinned card* (the only pinned card is the dragged one), return early. This lets a
   dragged card float OVER loci so it can be carried in and dropped — and stops a
   dragged card from shoving a closed locus away (which made drop targets unreachable).

2. **Card ↔ card → box (AABB), same-locus only.** If both are cards: only resolve if
   `a.locusId === b.locusId` (two homeless cards share the `undefined` group). Different
   clouds never collide — they're kept apart by their loci' footprints (§3), so cards
   from different loci never jostle. Uses `resolveBox` (below).

3. **Otherwise → circle.** Card↔locus (and the degenerate locus↔locus, which no-ops
   because both are immovable). Circle overlap = `a.radius + b.radius + padding - dist`.
   If `<= 0`, not touching, return.
   - **Loci are immovable to cards:** `invMass = 0` for any locus (regardless of its
     own `invMass` field), and 0 for a pinned card. So in a card↔locus contact the card
     takes the *entire* correction — cards **flow around** loci, never move them.
   - Split the correction by inverse mass: each body moves
     `normal * overlap * stiffness * (itsInvMass / totalInvMass)`.

### `resolveBox(a, b)` — AABB card↔card
```
half-extents: ahw=a.halfW??a.radius, ahh=a.halfH??a.radius (same for b)
ox = ahw+bhw+padding - |dx|     // x penetration
oy = ahh+bhh+padding - |dy|     // y penetration
if ox<=0 or oy<=0: return       // boxes disjoint
split by inverse mass (pinned card = 0)
push along the axis of LEAST penetration (min(ox,oy)), by that amount * stiffness
```
Cards are axis-aligned rectangles, so AABB (not circles) is what prevents the "corner
poke" overlap. `halfW/halfH` are measured from the real rendered card so collision
matches what's on screen (a card grows with its content).

### Why under-relaxation + alternating passes + sleep
Position-based relaxation has no convergence guarantee; at full stiffness a crowded,
symmetric packing can ping-pong or slowly rotate forever. Three dampers fix it:
- `stiffness < 1` — each push corrects only part of the overlap; overshoot dies out.
- alternating sweep direction per pass — cancels the first-mover bias that becomes
  rotation in a dense ring.
- **SLEEP** (phase 3): if a card's *net* movement over the whole frame is `< SLEEP_DIST`,
  snap it back to where it started the frame. A settled cloud then goes truly static
  instead of shimmering. (Loci are not slept — they're deterministic in phase 0.)

---

## 5. Locomancer: layout + queries the physics needs

### `cloudExtents(locusId) → {l, r, u, d}`
The cloud's bounding box, per direction, measured from the locus centre over the
locus's **active** cards: for each card, `r = max(r, offset.x + halfW)`,
`l = max(l, -offset.x + halfW)`, and similarly `d`/`u` with `offset.y ± halfH`. Floored
at 0. Worldbuilder's `footprint` uses these so an open locus only inflates the sides its
cards actually occupy.

### `defaultOffset(locus, idx, cardRadius) → Vec2` (concentric rings)
The default home OFFSET for card #idx of a locus: tidy concentric rings. Fill the
innermost ring with as many evenly spaced slots as its circumference allows
(`slots = floor(2πr / spacing)`), then the next ring out, etc. `spacing = shellStep =
cardRadius * 2.4`; ring radius `r = locusRadius + cardRadius + ring*shellStep`; alternate
rings staggered half a slot so cards don't line up into radial spokes. Returned as an
offset (relative), so it rides along with the locus.

### `seed(i) → Vec2` (anti-stacking nudge)
A tiny deterministic golden-angle spiral offset (`angle = i*2.399963`, small growing
radius). Used when a locus opens to scatter cards a hair off their exact homes, so
collision has a direction to push if two homes coincide (avoids a divide-by-zero / dead
stack). Deterministic — no randomness.

### `snapVec(v)` — lattice quantization
Rounds a vector's components to the nearest `lattice` (=8) node. Used by `placeCard`/
`assignCard` so dropped cards land on a fine grid. The lattice **only quantizes**; it
does NOT prevent overlap (collision does, separately). It's finer than a card so
diagonals/rings still work.

---

## 6. Deliberate acts (Locomancer state transitions)

These set intent; the physics then animates toward it.

- **`openLocus(id)`** — `locus.open = true`; for each of its cards set `active = true`
  and seed `position = locus.position + homeOffset + seed(i)`. Cards then bloom out via
  attraction; the locus's footprint inflates via `expand`, shoving neighbours.
- **`closeLocus(id)`** — `locus.open = false`; its cards `active = false` (vanish). The
  footprint deflates (`expand → 0`); neighbours spring back home.
- **`placeCard(id, at)`** — set the card's home to `at` (housed → `homeOffset =
  snap(at - locus.position)`; homeless → `target = snap(at)`) and bump it to
  `CARD_PLACED_INV_MASS` (heavier, holds its spot).
- **`assignCard(cardId, locusId, at?)`** — card joins a locus: adopt its colour, set
  `locusId`, reset to `CARD_INV_MASS`. Dropped on an OPEN locus → `active`, keep the
  drop spot as `homeOffset` (snapped); dropped on a CLOSED locus → `active:false`, home
  = next default ring slot (blooms there when opened).
- **`moveLocus(id, to)`** — set `position` and `target` to `to`, carry active cards by
  the delta (used during a locus drag).
- **`locusAtPoint(p)`** / **`setHighlightedLocus(id)`** — hit-test a locus circle (for
  drag-to-assign) and toggle the dashed "catch" ring.

---

## 7. Coordinate spaces & rendering hooks (so a new shell can plug in)

- All physics is in **world space**. The harness owns the camera; nothing in
  Worldbuilder/Locomancer knows about pan/zoom.
- `world.render(ctx)` draws **loci only**, in world space — the harness must apply the
  camera transform to `ctx` first. Locus drawing: auto-crops the PNG to its content box
  (`imageCrop`), fits the longest side to `radius*2`, centres it on `position`; an open
  locus adds a colour glow (double-draw with canvas shadow); `highlight` adds a dashed
  ring; a fallback circle-with-windows is drawn if no image is loaded.
- **Cards are rendered by whatever you build**, reading `entry.position` (centre) and
  `halfW/halfH` (size) each frame for every `activeEntries()` card. If cards are DOM,
  feed their measured size back into `halfW/halfH` so collision matches the DOM.
- A card renderer must also feed user gestures back into the Locomancer:
  drag → `pinned=true` + write `position` each move → on drop `placeCard` or (over a
  locus) `assignCard`; hover during drag → `locusAtPoint` + `setHighlightedLocus`.

---

## 8. Known issues / sharp edges

- **Collision is O(n²)** over active pairs. Fine for tens; add spatial hashing if clouds
  get large.
- **Card height** must be fed back from the renderer into `halfH`, or tall cards
  under-collide. (DOM path measures `offsetHeight`.)
- **Loci-both-closed still resolve footprints** (needed for propagation). This means
  two closed loci the user *places* overlapping will also separate. Usually fine; flag
  if it surprises.
- **No velocity / momentum.** Pure position relaxation. The article's "fling fast to
  detach" would need real velocity + friction — deliberately not built.
- **Slab field was tried and removed.** An earlier model inserted global axis-aligned
  slabs of space; it was complex and jumpy (axis-crossing discontinuities flipped
  loci). The footprint-collision model replaced it.

```
