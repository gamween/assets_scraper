import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Asset, Diagnostics, FontFamily, PageInfo, Palette, ScanEvent, ScanStats, StepId, WarningCode } from "@/lib/contract";
import {
  BACKGROUNDS,
  SORT_KEYS,
  assetKey,
  publicSourcesSection,
  sectionize,
  visibleItems,
  type Background,
  type Item,
  type Section,
  type SectionId,
  type SortKey,
  type Tab,
} from "./filters";
import type { ScanErrorInfo } from "./scan-client";
import { readString, writeString } from "./storage";
import type { ZipFailure } from "./zip";

export type Phase = "idle" | "scanning" | "results" | "error";
export type StepStatus = "active" | "done";

/** Canonical display order of the scan steps (spec 12.2). */
export const STEP_ORDER: readonly StepId[] = ["open", "queue", "load", "scroll", "collect", "process"];

export interface ZipProgress {
  source: "selection" | "all";
  done: number;
  total: number;
}

export interface AppState {
  phase: Phase;
  /** Set once the client has read preferences and the address bar (after hydration). */
  booted: boolean;
  /** Text of the URL field, shared by the landing and the top bar. */
  input: string;
  inputError: string | null;
  url: string | null;
  host: string | null;
  scanId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  steps: Partial<Record<StepId, StepStatus>>;
  page: PageInfo | null;
  /** `undefined` until the palette event arrives, `null` when the scan found none. */
  palette: Palette | null | undefined;
  assets: Asset[];
  fonts: FontFamily[];
  warnings: WarningCode[];
  done: { partial: boolean; stats: ScanStats; diagnostics: Diagnostics } | null;
  error: ScanErrorInfo | null;

  tab: Tab;
  query: string;
  sort: SortKey;
  background: Background;
  expanded: SectionId[];
  selection: ReadonlySet<string>;
  anchor: string | null;
  selectionMode: boolean;
  detailId: string | null;
  /**
   * A collapsed section whose asset opened in detail (through `&asset=<id>`). Detail navigation walks it until the
   * dialog closes; the grid, select-all and Download all treat it as they treat any collapsed section.
   */
  revealed: SectionId | null;
  zip: ZipProgress | null;
  /** Entries a finished ZIP had to skip, listed by the toast's `Show` action. */
  zipFailures: ZipFailure[] | null;
  recent: string[];

  setBooted(): void;
  setInput(input: string): void;
  setInputError(message: string | null): void;
  beginScan(target: { url: string; host: string }): void;
  restartAttempt(): void;
  applyEvent(event: Exclude<ScanEvent, { type: "error" }>): void;
  failScan(error: ScanErrorInfo): void;
  reset(input?: string): void;

  loadPreferences(): void;
  setTab(tab: Tab): void;
  setQuery(query: string): void;
  setSort(sort: SortKey): void;
  setBackground(background: Background): void;
  toggleSection(id: SectionId): void;

  select(key: string): void;
  toggle(key: string): void;
  selectRange(key: string): void;
  selectAllVisible(): void;
  clearSelection(): void;
  setSelectionMode(on: boolean): void;

  openDetail(id: string): void;
  closeDetail(): void;
  nextDetail(): void;
  previousDetail(): void;

  setZip(progress: ZipProgress | null): void;
  setZipFailures(failures: ZipFailure[] | null): void;
  setRecent(recent: string[]): void;
}

const SORT_KEY = "assets-scraper:sort";
const BACKGROUND_KEY = "assets-scraper:background";

const scanReset = {
  scanId: null,
  startedAt: null,
  finishedAt: null,
  steps: {},
  page: null,
  palette: undefined,
  assets: [],
  fonts: [],
  warnings: [],
  done: null,
  error: null,
  query: "",
  selection: new Set<string>(),
  anchor: null,
  selectionMode: false,
  detailId: null,
  revealed: null,
  zip: null,
  zipFailures: null,
} satisfies Partial<AppState>;

function applyStep(steps: AppState["steps"], step: StepId, state: "start" | "done"): AppState["steps"] {
  const next = { ...steps };
  if (state === "done") {
    next[step] = "done";
    return next;
  }
  next[step] = next[step] === "done" ? "done" : "active";
  // A later step implies the earlier ones finished. The queue sits inside "open", so it does not close it.
  if (step !== "queue") {
    for (const earlier of STEP_ORDER.slice(0, STEP_ORDER.indexOf(step))) if (next[earlier]) next[earlier] = "done";
  }
  return next;
}

export function createAppStore() {
  return createStore<AppState>()((set, get) => ({
    phase: "idle",
    booted: false,
    input: "",
    inputError: null,
    url: null,
    host: null,
    ...scanReset,
    tab: "all",
    sort: "relevance",
    background: "auto",
    expanded: [],
    recent: [],

    setBooted: () => set({ booted: true }),
    setInput: (input) => set({ input, inputError: null }),
    setInputError: (inputError) => set({ inputError }),

    beginScan: ({ url, host }) =>
      set({ ...scanReset, selection: new Set(), phase: "scanning", url, host, input: url, inputError: null, startedAt: Date.now(), expanded: [] }),

    restartAttempt: () => set({ steps: {}, scanId: null }),

    applyEvent: (event) => {
      switch (event.type) {
        case "accepted":
          return set({ scanId: event.scanId });
        case "step":
          return set((state) => ({ steps: applyStep(state.steps, event.step, event.state) }));
        case "page":
          // Sent twice (early, then with brand links and favicon): replace, never merge.
          return set({ page: event.page });
        case "palette":
          return set({ palette: event.palette });
        case "assets":
          return set((state) => ({ assets: [...state.assets, ...event.items] }));
        case "fonts":
          return set({ fonts: event.families });
        case "warning":
          return set((state) => ({ warnings: [...state.warnings, event.code] }));
        case "done":
          return set({
            phase: "results",
            done: { partial: event.partial, stats: event.stats, diagnostics: event.diagnostics },
            scanId: get().scanId ?? event.diagnostics.scanId,
            finishedAt: Date.now(),
          });
      }
    },

    failScan: (error) => set({ phase: "error", error, finishedAt: Date.now(), scanId: get().scanId ?? error.diagnostics?.scanId ?? null }),

    reset: (input) => set((state) => ({ ...scanReset, selection: new Set(), phase: "idle", url: null, host: null, input: input ?? state.input, inputError: null })),

    loadPreferences: () => {
      const sort = readString(SORT_KEY);
      const background = readString(BACKGROUND_KEY);
      set({
        sort: SORT_KEYS.includes(sort as SortKey) ? (sort as SortKey) : get().sort,
        background: BACKGROUNDS.includes(background as Background) ? (background as Background) : get().background,
      });
    },
    setTab: (tab) => set({ tab }),
    setQuery: (query) => set({ query }),
    setSort: (sort) => {
      writeString(SORT_KEY, sort);
      set({ sort });
    },
    setBackground: (background) => {
      writeString(BACKGROUND_KEY, background);
      set({ background });
    },
    toggleSection: (id) =>
      set((state) => ({ expanded: state.expanded.includes(id) ? state.expanded.filter((item) => item !== id) : [...state.expanded, id] })),

    select: (key) => set((state) => ({ selection: new Set(state.selection).add(key), anchor: key })),
    toggle: (key) =>
      set((state) => {
        const selection = new Set(state.selection);
        if (selection.has(key)) selection.delete(key);
        else selection.add(key);
        return { selection, anchor: key };
      }),
    selectRange: (key) =>
      set((state) => {
        const keys = getVisibleItems(state).map((item) => item.key);
        const end = keys.indexOf(key);
        if (end < 0) return {};
        const anchorIndex = state.anchor ? keys.indexOf(state.anchor) : -1;
        const start = anchorIndex < 0 ? 0 : anchorIndex;
        const [from, to] = start <= end ? [start, end] : [end, start];
        const selection = new Set(state.selection);
        for (const item of keys.slice(from, to + 1)) selection.add(item);
        return { selection, anchor: key };
      }),
    selectAllVisible: () =>
      set((state) => {
        const selection = new Set(state.selection);
        for (const item of getVisibleItems(state)) selection.add(item.key);
        return { selection };
      }),
    clearSelection: () => set({ selection: new Set(), anchor: null, selectionMode: false }),
    setSelectionMode: (selectionMode) => set({ selectionMode }),

    openDetail: (id) =>
      set((state) => {
        if (!findAsset(state, id)) return {};
        const section = getSections(state).find((item) => item.kind === "assets" && item.items.some((asset) => asset.id === id));
        const collapsed = section?.collapsible && !state.expanded.includes(section.id);
        return { detailId: id, revealed: collapsed ? section.id : null };
      }),
    closeDetail: () => set({ detailId: null, revealed: null }),
    nextDetail: () => set((state) => ({ detailId: stepDetail(state, 1) })),
    previousDetail: () => set((state) => ({ detailId: stepDetail(state, -1) })),

    setZip: (zip) => set({ zip }),
    setZipFailures: (zipFailures) => set({ zipFailures }),
    setRecent: (recent) => set({ recent }),
  }));
}

function stepDetail(state: AppState, delta: number): string | null {
  const list = getDetailList(state);
  if (!list.length) return state.detailId;
  const index = list.findIndex((asset) => asset.id === state.detailId);
  if (index < 0) return list[0].id;
  return list[(index + delta + list.length) % list.length].id;
}

type SectionInputs = [Asset[], FontFamily[], Tab, string, SortKey, Phase, ScanErrorInfo | null];
let sectionsCache: { inputs: SectionInputs; value: Section[] } | null = null;

const sameInputs = <T extends unknown[]>(a: T, b: T) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** Sections for the current tab, search and sort. Memoized on its inputs so React selectors stay stable. */
export function getSections(state: AppState): Section[] {
  const inputs: SectionInputs = [state.assets, state.fonts, state.tab, state.query, state.sort, state.phase, state.error];
  if (sectionsCache && sameInputs(sectionsCache.inputs, inputs)) return sectionsCache.value;
  const fallback = state.phase === "error" && !state.assets.length ? (state.error?.fallback ?? []) : [];
  const value = fallback.length
    ? publicSourcesSection(fallback, state)
    : sectionize(state.assets, state.fonts, { tab: state.tab, query: state.query, sort: state.sort });
  sectionsCache = { inputs, value };
  return value;
}

let visibleCache: { sections: Section[]; expanded: SectionId[]; value: Item[] } | null = null;

/**
 * Items of the current tab and search in visual order, as the grid renders them (spec 12.4). Collapsed sections stay
 * out until the user expands them, whether or not a search is active.
 */
export function getVisibleItems(state: AppState): Item[] {
  const sections = getSections(state);
  if (visibleCache && visibleCache.sections === sections && visibleCache.expanded === state.expanded) return visibleCache.value;
  const value = visibleItems(sections, new Set(state.expanded));
  visibleCache = { sections, expanded: state.expanded, value };
  return value;
}

let detailCache: { items: Item[]; revealed: SectionId | null; value: Asset[] } | null = null;

/**
 * Assets that detail navigation walks through: the visible assets of the current tab and search, plus the collapsed
 * section of an asset opened from the address bar while its dialog is open.
 */
export function getDetailList(state: AppState): Asset[] {
  const visible = getVisibleItems(state);
  if (detailCache && detailCache.items === visible && detailCache.revealed === state.revealed) return detailCache.value;
  const items = state.revealed ? visibleItems(getSections(state), new Set([...state.expanded, state.revealed])) : visible;
  const value = items.flatMap((item) => (item.kind === "asset" ? [item.asset] : []));
  detailCache = { items: visible, revealed: state.revealed, value };
  return value;
}

/** Sections that `Download all` takes even while collapsed: only small icons wait for `Show` (spec 12.4). */
const DOWNLOAD_ALL_SECTIONS: readonly SectionId[] = ["stylesheets", "declared-fonts"];

/**
 * Spec 12.4 `Download all`: every item of the current tab, whatever the search, in visual order, small icons only
 * when that section is expanded. Stylesheet-only files and unused fonts are in even while their sections are collapsed.
 */
export function getDownloadAllItems(state: AppState): Item[] {
  const fallback = state.phase === "error" && !state.assets.length ? (state.error?.fallback ?? []) : [];
  const sections = fallback.length
    ? publicSourcesSection(fallback, { query: "", sort: state.sort })
    : sectionize(state.assets, state.fonts, { tab: state.tab, query: "", sort: state.sort });
  return visibleItems(sections, new Set([...state.expanded, ...DOWNLOAD_ALL_SECTIONS]));
}

export function findAsset(state: AppState, id: string | null): Asset | null {
  if (!id) return null;
  return state.assets.find((asset) => asset.id === id) ?? state.error?.fallback?.find((asset) => asset.id === id) ?? null;
}

export { assetKey };

export const appStore = createAppStore();

export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}
