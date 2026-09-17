"use client";

import { ChevronDown, Search, SquareCheck, XIcon } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/components/common/cn";
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
              "relative flex shrink-0 items-center gap-1.5 border-b-2 text-body font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:text-text focus-visible:after:absolute focus-visible:after:inset-x-[-6px] focus-visible:after:inset-y-2.5 focus-visible:after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-accent",
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

  return (
    <div className="relative min-w-0 flex-1 sm:w-[240px] sm:flex-none lg:w-[280px]">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-3" aria-hidden="true" />
      <input
        ref={inputRef}
        id={SEARCH_INPUT_ID}
        type="search"
        aria-label="Filter by name or URL"
        aria-keyshortcuts="/"
        placeholder="Filter by name or URL"
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
        className="peer h-8 w-full rounded-md border border-border bg-surface pr-8 pl-8 text-body text-text transition-[border-color,box-shadow] duration-100 outline-none placeholder:text-text-3/80 hover:border-border-strong focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] [&::-webkit-search-cancel-button]:hidden"
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
        <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 peer-focus-visible:opacity-0">/</Kbd>
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
              "h-full rounded-[4px] px-2.5 text-small transition-colors duration-100 outline-none focus-visible:outline-2 focus-visible:outline-accent",
              active ? "bg-surface font-medium text-text shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)]" : "text-text-2 hover:text-text",
            )}
          >
            {BACKGROUND_LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}

/** Spec 12.2 sticky filter row: tabs with counts, search (`/`), sort and the preview background control. */
export function FilterBar() {
  const background = useApp((s) => s.background);
  const setBackground = useApp((s) => s.setBackground);
  const selectionMode = useApp((s) => s.selectionMode);
  const setSelectionMode = useApp((s) => s.setSelectionMode);
  const clearSelection = useApp((s) => s.clearSelection);

  return (
    <div className="sticky top-[calc(var(--top-bar-height)+env(safe-area-inset-top,0px))] z-30 mt-6 border-b border-border bg-bg">
      <div className="page-x flex flex-wrap items-stretch gap-x-6 md:h-(--filter-bar-height) md:flex-nowrap">
        <div className="flex h-11 min-w-0 flex-1 items-stretch md:h-auto md:flex-none">
          <Tabs />
        </div>
        <div className="flex w-full items-center gap-2 pb-2.5 md:ml-auto md:w-auto md:pb-0">
          <SearchField />
          <SortSelect />
          <BackgroundControl value={background} onChange={setBackground} className="hidden sm:flex" />
          <button
            type="button"
            aria-pressed={selectionMode}
            onClick={() => (selectionMode ? clearSelection() : setSelectionMode(true))}
            className={cn(
              "hidden h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-body pointer-coarse:inline-flex",
              selectionMode ? "border-accent bg-accent-soft text-text" : "border-border bg-surface text-text-2",
            )}
          >
            <SquareCheck className="size-4" aria-hidden="true" />
            {selectionMode ? "Done" : "Select"}
          </button>
        </div>
      </div>
    </div>
  );
}
