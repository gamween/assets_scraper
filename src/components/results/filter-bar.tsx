"use client";

import { ChevronDown, Search, SquareCheck, XIcon } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/components/common/cn";
import { useMediaQuery } from "@/components/common/use-media-query";
import { Kbd } from "@/components/common/kbd";
import { BACKGROUNDS, SORT_KEYS, TABS, tabCounts, type Background, type SortKey, type Tab } from "@/lib/client/filters";
import { useApp } from "@/lib/client/store";

const TAB_LABELS: Record<Tab, string> = { all: "All", svg: "SVG", images: "Images", fonts: "Fonts" };
const SORT_LABELS: Record<SortKey, string> = { relevance: "Relevance", "page-order": "Page order", largest: "Largest", "file-size": "File size", name: "Name" };
const BACKGROUND_LABELS: Record<Background, string> = { auto: "Auto", light: "Light", dark: "Dark", grid: "Grid" };

export const SEARCH_INPUT_ID = "results-search";

function Tabs() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const assets = useApp((s) => s.assets);
  const fonts = useApp((s) => s.fonts);
  const query = useApp((s) => s.query);
  const counts = tabCounts(assets, fonts, query);

  return (
    <div role="tablist" aria-label="Asset types" className="-mb-px flex h-full min-w-0 items-stretch gap-5 overflow-x-auto scrollbar-none">
      {TABS.map((id, index) => {
        const active = id === tab;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-keyshortcuts={String(index + 1)}
            onClick={() => setTab(id)}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 border-b-2 text-body font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:text-text focus-ring-tab",
              active ? "border-ink text-text" : "border-transparent text-text-2 hover:text-text",
              counts[id] === 0 && !active && "text-text-3",
            )}
          >
            {TAB_LABELS[id]}{" "}
            <span className="font-mono text-mono text-text-3 tabular-nums">{counts[id]}</span>
          </button>
        );
      })}
    </div>
  );
}

function SearchField() {
  const query = useApp((s) => s.query);
  const setQuery = useApp((s) => s.setQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  // Below 480 the row is the input, the sort control and, on touch, the Select button: the full placeholder does not
  // fit what is left and was cut to `Filter by nan`. The accessible name stays the long one.
  const narrow = useMediaQuery("(max-width: 479px)");

  return (
    <div className="relative min-w-0 flex-1 sm:max-w-[280px] lg:w-[280px] lg:flex-none">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-3" aria-hidden="true" />
      <input
        ref={inputRef}
        id={SEARCH_INPUT_ID}
        type="search"
        aria-label="Filter by name or URL"
        aria-keyshortcuts="/"
        placeholder={narrow ? "Filter" : "Filter by name or URL"}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (query) setQuery("");
            else inputRef.current?.blur();
          }
        }}
        className="peer h-8 w-full rounded-md border border-border bg-surface pr-8 pl-8 text-body text-text transition-[border-color,box-shadow] duration-100 outline-none placeholder:text-text-3 hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
          className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-text-3 hover:bg-well hover:text-text"
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : (
        <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 peer-focus-visible:opacity-0 pointer-coarse:hidden">/</Kbd>
      )}
    </div>
  );
}

function SortSelect() {
  const sort = useApp((s) => s.sort);
  const setSort = useApp((s) => s.setSort);
  return (
    <div className="relative shrink-0">
      <select
        aria-label="Sort"
        value={sort}
        onChange={(event) => setSort(event.target.value as SortKey)}
        className="h-8 appearance-none rounded-md border border-border bg-surface pr-8 pl-2.5 text-body text-text transition-colors duration-100 outline-none hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
      >
        {SORT_KEYS.map((key) => (
          <option key={key} value={key}>
            {SORT_LABELS[key]}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-text-3" aria-hidden="true" />
    </div>
  );
}

/** Segmented `Auto · Light · Dark · Grid` control. Arrow keys move between options, like native radios. */
export function BackgroundControl({ value, onChange, className }: { value: Background; onChange: (value: Background) => void; className?: string }) {
  return (
    <div
      role="radiogroup"
      aria-label="Preview background"
      className={cn("flex h-8 shrink-0 items-center rounded-md border border-border bg-well p-0.5", className)}
      onKeyDown={(event) => {
        const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!delta) return;
        event.preventDefault();
        const next = BACKGROUNDS[(BACKGROUNDS.indexOf(value) + delta + BACKGROUNDS.length) % BACKGROUNDS.length];
        onChange(next);
        (event.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {BACKGROUNDS.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            data-value={option}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option)}
            className={cn(
              "h-full rounded-[4px] border px-2.5 text-small transition-colors duration-100 focus-ring-tight",
              active ? "border-border bg-surface font-medium text-text" : "border-transparent text-text-2 hover:text-text",
            )}
          >
            {BACKGROUND_LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}

/** A swatch of a preview background: `Auto` is half light, half dark. */
function BackgroundSwatch({ value }: { value: Background }) {
  return (
    <span aria-hidden="true" className={cn("relative size-3.5 shrink-0 overflow-hidden rounded-[3px] border border-border-strong", value === "grid" ? "bg-grid [background-size:7px_7px]" : value === "dark" ? "bg-preview-dark" : "bg-preview-light")}>
      {value === "auto" ? <span className="absolute inset-y-0 right-0 w-1/2 bg-preview-dark" /> : null}
    </span>
  );
}

/**
 * The same `Auto · Light · Dark · Grid` choice for phones, where the segmented control does not fit the filter row: a
 * swatch of the current background over a native select, so the options open in the system picker.
 */
function BackgroundSelect({ value, onChange, className }: { value: Background; onChange: (value: Background) => void; className?: string }) {
  return (
    <div
      className={cn(
        "relative flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-surface pr-1.5 pl-2 text-text-3 transition-colors duration-100 hover:border-border-strong has-[select:focus-visible]:border-accent has-[select:focus-visible]:shadow-[0_0_0_3px_var(--accent-soft)]",
        className,
      )}
    >
      <BackgroundSwatch value={value} />
      <ChevronDown className="size-3.5" aria-hidden="true" />
      <select
        aria-label="Preview background"
        value={value}
        onChange={(event) => onChange(event.target.value as Background)}
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0 outline-none"
      >
        {BACKGROUNDS.map((option) => (
          <option key={option} value={option}>
            {BACKGROUND_LABELS[option]}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Spec 12.4 `Select` button, on touch devices only: the checkboxes need a hover the device does not have. */
function SelectionToggle({ className }: { className?: string }) {
  const selectionMode = useApp((s) => s.selectionMode);
  const setSelectionMode = useApp((s) => s.setSelectionMode);
  return (
    <button
      type="button"
      aria-pressed={selectionMode}
      // Done leaves selection mode and keeps what is ticked: the bar's own Clear is the one explicit discard.
      onClick={() => setSelectionMode(!selectionMode)}
      className={cn(
        "h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-body",
        selectionMode ? "border-accent bg-accent-soft text-text" : "border-border bg-surface text-text-2",
        className,
      )}
    >
      <SquareCheck className="size-4" aria-hidden="true" />
      {selectionMode ? "Done" : "Select"}
    </button>
  );
}

/**
 * Spec 12.2 sticky filter row: tabs with counts, search (`/`), sort and the preview background control. One row from
 * 1024 px; below, the tabs sit over the controls, and phones pick the background from a compact select next to the tabs.
 */
export function FilterBar() {
  const background = useApp((s) => s.background);
  const setBackground = useApp((s) => s.setBackground);

  return (
    <div className="sticky top-[calc(var(--top-bar-height)+env(safe-area-inset-top,0px))] z-30 mt-6 border-b border-border bg-bg">
      <div className="page-x flex flex-wrap items-stretch gap-x-6 lg:h-(--filter-bar-height) lg:flex-nowrap">
        <div className="flex h-11 min-w-0 flex-1 items-stretch gap-2 lg:h-auto lg:flex-none">
          <Tabs />
          <BackgroundSelect value={background} onChange={setBackground} className="ml-auto self-center sm:hidden" />
        </div>
        <div className="flex w-full items-center gap-2 pb-2.5 lg:ml-auto lg:w-auto lg:pb-0">
          <SearchField />
          <SortSelect />
          <BackgroundControl value={background} onChange={setBackground} className="hidden sm:flex" />
          <SelectionToggle className="hidden pointer-coarse:inline-flex" />
        </div>
      </div>
    </div>
  );
}
