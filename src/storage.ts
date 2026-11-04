import type { SpatialEntry } from "./types";
import type { CardContent } from "./cards";
import type { Connection } from "./connections";
import type { Stroke } from "./ink";

// ---------------------------------------------------------------------------
// Persistence types + a storage backend abstraction.
//
// One MapState is everything on a single map; WorldFile is the whole document
// (all maps + which is active). Persistence is Electron file storage; outside
// Electron a no-op backend is used (the app is desktop-only).
// ---------------------------------------------------------------------------
export type MapState = {
  entries: SpatialEntry[]; //               loci + cards (spatial)
  content: Record<string, CardContent>; //  card content by id
  connections: Connection[];
  strokes?: Stroke[]; //                    loose ink (optional: older saves lack it)
};

// A graduated hand-drawn drawing, reusable from the toolbar. Strokes are stored
// center-relative (like a stroke-backed locus). GLOBAL across all maps.
export type StrokeStamp = { id: string; strokes: Stroke[] };

export type WorldFile = {
  version: 1;
  maps: { id: string; name: string; state: MapState }[];
  activeId: string;
  stamps?: StrokeStamp[]; //        user-graduated reusable drawings (optional: older saves lack it)
  hiddenPresets?: string[]; //      preset drawing filenames the user has removed from the toolbar
};

export interface Storage {
  load(): Promise<WorldFile | null>;
  save(world: WorldFile): Promise<void>;
}

// A link's fetched preview (title/description + screenshot-or-og:image thumbnail).
export type LinkMeta = { title: string; description: string; image: string };

// --- Machine ("Propose reading") tool types -------------------------------
// One card's content, flattened for sending to the Machine's LLM.
export type ReadingItem = { title: string; note?: string; url?: string; description?: string };
// What the lasso enclosed: zero+ houses (each with its cards) and zero+ loose cards.
// Carried alongside the whole conversation as the grounding context.
export type MachineContext = { houses: { cards: ReadingItem[] }[]; cards: ReadingItem[] };
// One turn of the dialogue.
export type ChatMessage = { role: "user" | "assistant"; text: string };
// A request: the lassoed context + the conversation so far (last message is the new
// user turn), plus the chosen model.
export type ChatRequest = { context: MachineContext; messages: ChatMessage[]; model?: string };
// A single proposed reading (the Add button turns its `url` into a real card).
export type ReadingSuggestion = { title: string; url: string; why: string };
// The assistant's reply: prose + zero+ Add-able readings. `noKey` is set when the
// Machine has no API key configured (the reply explains how to add one).
export type ChatReply = { reply: string; suggestions: ReadingSuggestion[]; noKey?: boolean };

// Electron exposes this on window via the preload bridge (see electron/preload.cjs).
declare global {
  interface Window {
    locusAPI?: {
      load: () => Promise<WorldFile | null>;
      save: (world: WorldFile) => Promise<void>;
      fetchLink: (url: string) => Promise<LinkMeta | null>;
      loginGoogle: () => Promise<boolean>;
      authStatus: () => Promise<boolean>;
      openLink: (url: string) => Promise<void>;
      gcThumbs: (names: string[]) => Promise<void>;
      machineChat: (req: ChatRequest) => Promise<ChatReply>;
      onMachineStatus: (cb: (status: string) => void) => () => void;
    };
  }
}

class ElectronStorage implements Storage {
  load() {
    return window.locusAPI!.load();
  }
  save(world: WorldFile) {
    return window.locusAPI!.save(world);
  }
}

// Used only if the app is opened outside Electron (e.g. a bare `vite` server for a
// quick visual check) — it just doesn't persist. Not a supported runtime.
class NoStorage implements Storage {
  async load() {
    return null;
  }
  async save() {}
}

export function makeStorage(): Storage {
  return window.locusAPI ? new ElectronStorage() : new NoStorage();
}
