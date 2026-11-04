# house

## Basic idea
A memory-palace tool for curating documents with drawing capabilities and spatially-aware,
limited machine assistance.

Documents and notes are Cards. You can assign Cards to Loci (pictures, the default being 
some houses I drew) that light up and expand their Cards when clicked. Cards either belong 
to a Locus or are untethered. The expansion of a Locus is physics-based, i.e., Cards and 
Loci can shove one another aside (excellent idea taken from Amelia Wattenberger.)
You can also draw directly on the canvas if you have a tablet or iPad to hook up (I
have been using the Sidecar feature on an iPad paired with an Apple Pencil.)
There's also a toolbox with one tool hooked up where you can lasso a set of
Cards and ask an LLM to find other resources that are related to what you circled.
The thought behind that tool is that you ought to be able to invoke assistance from
the machine without entering into a dialogue that could skew your early thinking,
i.e., communicating your mental model entirely through spatial organization.

Documentation below is mostly Claudish.

---

## Architecture

Layers with strict responsibilities. NOTE: there are **no `Locus`/`Card`/`World`
classes** yet — Cards and Loci are `SpatialEntry` rows in the Locomancer plus a
`CardContent` entry (and connections live in the ConnectionLayer).

| Concern | Module | Responsibility |
| --- | --- | --- |
| **Where things are** | `Locomancer` | the spatial registry (`SpatialEntry` rows), lattice snapping, open/close, assign, serialize/load |
| **Motion + locus drawing** | `Worldbuilder` | locus layout (spring + footprint collision), card physics (attraction + AABB collision), draws loci to canvas |
| **Card DOM** | `CardLayer` | renders each card as an editable HTML element over the canvas; drag/resize/highlight/connection-handle |
| **Connections** | `ConnectionLayer` | SVG curves between cards; drag-to-connect, click-to-delete |
| **Content** | `cards.ts` + `sourceDetector.ts` | card content model; URL → source/icon/title |
| **Persistence** | `storage.ts` | `WorldFile`/`MapState` + Electron file storage (no-op outside Electron) |
| **Misc** | `palette.ts`, `imageCrop.ts`, `undo.ts`, `types.ts` | colours; PNG content-bounds; structural undo; shared types |

Key contract: **`Locomancer` sets `target`/`homeOffset` (intent); `Worldbuilder` sets `position` (motion).** The camera (pan/zoom) lives in
`main.ts`; the canvas, the card DOM "stage", and the connection SVG all share one camera transform each frame.

Stack: **TypeScript + Vite**. Loci on an **HTML canvas**; cards as **DOM**;
connections as **SVG** — a hybrid, all camera-synced. **Electron** shell for desktop
(`electron/main.cjs` + `preload.cjs`).

## Physics (current behaviour)

> **See [`PHYSICS.md`](./PHYSICS.md) for the full, detailed spec** — the data model
> (`SpatialEntry`), the frame loop, every collision rule, all constants, and the
> rendering/gesture hooks a new shell must provide.

Two separate systems are run every frame in `Worldbuilder.step()`:

**Loci (`locusStep`).** Each locus springs gently toward its **placed home**; then
any two **locus+cloud footprints** that would overlap are pushed fully apart (with a
gap), carrying their cards with them. Closed Loci yield to open ones. Two open Loci 
split the intermediate space 50/50. Closing Loci shrinks the footprint so neighbours
spring back to their original positions. Footprint size animates (`expand`) so
space opens/closes smoothly. Loci can be dragged.

**Cards.** Each card is a body whose **home** is an *offset from its locus*
(`homeOffset`), so the whole Card cloud rides along when the locus moves. Cards attract to
their home and resolve overlaps with **box (AABB) collision** — but only against
*same-locus* siblings (different clouds never jostle; the loci keep them apart).
Cards **flow around loci** (loci are immovable to cards). A dragged card is lifted
and floats over loci so it can be carried in and dropped. Default homes are tidy
concentric-ring slots; dropping a card sets its home (snapped to a fine lattice);
real card size is measured from the DOM so collision matches what's on screen.

Tunables (constants in `Worldbuilder.ts`): `attraction`, `iterations`, `padding`,
`stiffness`, `LOCUS_SPRING`, `LOCUS_ITERATIONS`, `LOCUS_STIFFNESS`, `LOCUS_GAP`,
`EXPAND_EASE`, `SLEEP_DIST`; lattice in `Locomancer`.

---

## Cards, toolbar, connections

- **Create:** paste a URL/text anywhere, drag-drop a URL, or double-click empty space.
- **Edit:** title + note are editable in place; note stores HTML (for highlights).
- **Link cards:** a URL card shows a ↗ that opens the link, and (in Electron) a
  fetched **page-screenshot thumbnail** + title (see Link previews below).
- **Icon:** click a card's emoji to pick a new one (searchable popover, `emojiPicker.ts`).
  Icon is shared identity → syncs across a document's placements. (Seeds later "visual metaphor" work.)
- **Resize:** drag the bottom-right corner; new size feeds the physics + persists.
- **Connections:** drag the ● handle on a card's right edge to another card; click a
  line to delete. A connection to a card inside a *closed* locus retracts to the
  locus's edge.
- **Toolbar (top, right side):** **✎ Highlight** toggle, **↩ Undo**, and **🗑 Delete**
  (appears only when exactly one locus is open; confirms, removes the locus + its
  cards, undoable). Plus the locus-drawing palette on the left.
- **Undo** is *structural only* (add/delete/move/assign cards & loci, connect/
  disconnect); text edits use the browser's own undo. Shortcut: ⌘/Ctrl+Z.
- **Colour** is deferred — cards just inherit their locus's colour for now.

## Documents vs. cards (duplication)

A **card is a placement of a document in a context.** Many cards can point at one
document (its `docId`), each with its **own note** but a **shared identity** (title,
url, source, icon — title syncs across placements).

- **Identity is an internal `docId`**, never the url/title (those are unreliable —
  same paper at different URLs, flaky title fetch).
- **Exact-URL dedup (current):** re-pasting a link whose *normalized* URL already
  exists makes the new card a placement of that same document. A `urlIndex`
  (`normalizedUrl → docId`) keeps the check O(1) even with many documents; it's
  rebuilt from the cards on map load.
- **Plain notes** (no URL) are always their own unique document.
- **"Also in…":** select a card → the minimap rings the loci / loose spots holding
  other placements of its document, and a label shows the count. Current map only.

### Link previews (Electron only)

Pasting a new link fetches title/description/thumbnail (`fetchPreview` in `main.ts` →
`locusAPI.fetchLink`). The card shows a "fetching preview…" strip, then the thumbnail +
title. Preview/title/description are **document-level** (shared across placements).

**Title/description/image** come from a **direct HTTP GET + HTML meta parse** (the
`info_board` approach — `fetchHtmlMeta` in `main.cjs`): a plain `net.request` with a
desktop User-Agent reads the server-rendered `<head>` (`og:`/`twitter:`/`citation_`/
`<title>`). This is the reliable base — unlike a hidden-window load it can't be stalled
or blocked into returning nothing (the bug that left e.g. Springer links blank).

**Academic / DOI links** (Springer, SSRN, Nature, …) bot-wall the page itself (Imperva
"Client Challenge", Cloudflare "Just a moment") so both the GET and the window come back
empty. For these, the DOI sitting in the URL is resolved against **Crossref**
(`api.crossref.org`, un-walled) for the real title + an authors·journal·year description
(`extractDoi` / `fetchCrossref` in `main.cjs`; SSRN's `abstract_id` maps to a
`10.2139/ssrn.<id>` DOI). This is more robust than `info_board`, which only worked on
these when its session happened to carry the publisher's cookies.

On top of that, the main process loads the URL in a **hidden window** on the shared
persistent session and **`capturePage()`s a real screenshot** for the thumbnail (and
fills any metadata the GET missed, e.g. JS-rendered pages). The JPEG is written to
`userData/thumbs/<sha1>.jpg` and referenced as **`locus-thumb://<name>`** (custom
protocol) — not inlined into `world.json`. Orphan thumbnails are GC'd on each save.
The screenshot is preferred for the image; it falls back to `og:image` when the page is
a **bot-challenge/interstitial** (detected by title/body signs) or the capture fails. A
failed window load never loses the GET metadata. **Google sign-in** (toolbar →
`auth:google`; button shows **✓ Google**) authenticates that session so **Drive** links
fetch while logged in. Clicking a card's **↗ opens the link in the OS browser** (Safari)
via `shell.openExternal`.

---

## Maps + sidebar

- **Collapsible sidebar** ("Maps" header + a circle button that retracts it
  upward): a list of **maps** (switch / rename / delete / + new) and a **minimap**
  (loci + cards; click to recentre; rings the selected card's other placements).
- Each map is an independent world (loci, cards, connections).
- **Autosave** every 2s and on close; reloads on startup.

---

## Machine (the bottom-right panel)

A companion to the Maps sidebar, but for **machine help**. 
You pick a **tool** (what help), draw a **lasso** (where), and only then does a
**dialogue** open. One tool is wired: **Propose reading**.

- **Flow:** click *Propose reading* → the panel shows a chat in an "armed" state →
  lasso any houses and/or cards (even a single card → "more like this") → the enclosed
  cards are sent to Claude, which **searches the web** and proposes readings that bridge
  the selection. It's an **iterative dialogue**: type follow-ups ("narrower", "empirical
  only", "more like #2") for more; re-lasso any time to add context. Each suggestion has
  an **Add** button that drops a real card near the lasso (it fetches its own
  title/abstract/thumbnail — no LLM-written text stored). **← Back** / **Esc** disarms.
- **Model toggle** in the tools view: **Opus 4.8** (default, best) or **Sonnet 4.6**
  (cheaper). Prompt caching is on (the selection + conversation prefix are cached), so
  re-sending a growing chat stays cheap.

Note: The idea behind the Propose Reading tool is that the LLM only provides suggestions,
but doesn't produce text explaining or interpreting. Right now the LLM isn't 
sufficiently muzzled, so it *does* explain things at the top of its response.

### API key (required for the Machine)

The Machine calls the **Anthropic API** (`machine:chat` in `electron/main.cjs`, via
`@anthropic-ai/sdk` + the server-side `web_search` tool). This is **separate from any
Claude Pro/Max subscription** — it needs its own key with API billing
([console.anthropic.com](https://console.anthropic.com); set a spend cap). Provide it as
an environment variable and restart:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run build && npm run electron
```

Without the key the Machine just replies that no key is configured (no fallback stub).

---

## Run

Desktop-only (Electron). The browser/`vite` path still renders for a quick visual
check but does not persist or fetch link previews.

```bash
npm install                 # also pulls in Electron (devDependency)
npm run build               # typecheck + production bundle
npm run electron            # run the desktop app (after build)
# live dev: run `npm run dev` in one terminal, `npm run electron:dev` in another
npm run check               # typecheck only
```
