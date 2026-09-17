"use client";

import { CircleAlert, FileWarning, KeyRound, Lock, ShieldAlert, TimerOff } from "lucide-react";
import { copyWithToast } from "@/components/results/asset-actions";
import { Button } from "@/components/ui/button";
import { rescan } from "@/lib/client/scan-session";
import type { ScanErrorInfo } from "@/lib/client/scan-client";
import { useApp } from "@/lib/client/store";
import { AccessCodePrompt } from "./access-code-dialog";

type Action = "try-another" | "try-again" | "reload" | "rescan" | "debug";

interface ErrorCopy {
  title: string;
  line?: string;
  actions: Action[];
  icon: typeof CircleAlert;
}

const CANT_SCAN = "This address can't be scanned";
const CHECK_ADDRESS = "Check the address and try again.";

/** Spec 13: title, line and actions for every error code. */
export function errorCopy(error: ScanErrorInfo, host: string): ErrorCopy {
  switch (error.code) {
    case "invalid-url":
      return { title: "Enter a web address, like linear.app", actions: ["try-another"], icon: CircleAlert };
    case "blocked-address":
      return { title: CANT_SCAN, line: "Local and private network addresses are blocked.", actions: ["try-another"], icon: Lock };
    case "unsupported-port":
      return { title: CANT_SCAN, line: "Only ports 80 and 443 are supported.", actions: ["try-another"], icon: Lock };
    case "own-host":
      return { title: CANT_SCAN, line: "Assets Scraper can't scan itself.", actions: ["try-another"], icon: Lock };
    case "rate-limited":
      return { title: "Too many scans", line: "Wait a few minutes and try again.", actions: ["try-again"], icon: TimerOff };
    case "budget":
      return { title: "Daily scan limit reached", line: "Try again tomorrow.", actions: [], icon: TimerOff };
    case "disabled":
      return { title: "Scanning is paused", line: "Try again later.", actions: [], icon: TimerOff };
    case "access-code":
      return { title: "Enter the access code", actions: [], icon: KeyRound };
    case "bot":
      return { title: "The scan request was blocked", line: "Reload the page and try again.", actions: ["reload"], icon: ShieldAlert };
    case "busy":
      return { title: "All browsers are busy", line: "Try again in a moment.", actions: ["try-again"], icon: TimerOff };
    case "dns":
      return { title: `Couldn't find ${host}`, line: CHECK_ADDRESS, actions: ["try-again"], icon: CircleAlert };
    case "connect":
      return { title: `Couldn't reach ${host}`, line: CHECK_ADDRESS, actions: ["try-again"], icon: CircleAlert };
    case "http":
      return { title: error.httpStatus ? `${host} returned ${error.httpStatus}` : `${host} returned an error`, line: "The page may have moved.", actions: ["try-again"], icon: CircleAlert };
    case "blocked":
      return { title: `${host} blocked the scan`, line: "The site uses bot protection. Try another page on the site, or try again later.", actions: ["try-again"], icon: ShieldAlert };
    case "not-html":
      return { title: "This URL is a file, not a page", line: "You can download it directly.", actions: [], icon: FileWarning };
    case "timeout":
      return { title: "The page took too long to load", actions: ["rescan"], icon: TimerOff };
    case "internal":
      return { title: "Something went wrong on our side", actions: ["try-again", "debug"], icon: CircleAlert };
  }
}

export function focusAddress() {
  const input = document.querySelector<HTMLInputElement>("[data-testid=top-bar-url]");
  input?.focus();
  input?.select();
}

function copyDebugInfo(error: ScanErrorInfo, scanId: string | null, url: string | null) {
  const debug = {
    scanId: scanId ?? error.diagnostics?.scanId ?? null,
    code: error.code,
    message: error.message,
    httpStatus: error.httpStatus ?? null,
    url,
    at: new Date().toISOString(),
    diagnostics: error.diagnostics ?? null,
  };
  copyWithToast(JSON.stringify(debug, null, 2), "Debug info copied");
}

/** Spec 12.2 errors: a panel in place of the status block, with the failed step context and the spec 13 copy. */
export function ErrorPanel({ error }: { error: ScanErrorInfo }) {
  const host = useApp((s) => s.host ?? "");
  const scanId = useApp((s) => s.scanId);
  const url = useApp((s) => s.url);
  const copy = errorCopy(error, host);
  const Icon = copy.icon;

  const buttons: Record<Action, React.ReactNode> = {
    "try-another": (
      <Button key="try-another" variant="secondary" onClick={focusAddress}>
        Try another URL
      </Button>
    ),
    "try-again": (
      <Button key="try-again" variant="primary" onClick={rescan}>
        Try again
      </Button>
    ),
    reload: (
      <Button key="reload" variant="primary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    ),
    rescan: (
      <Button key="rescan" variant="primary" onClick={rescan}>
        Rescan
      </Button>
    ),
    debug: (
      <Button key="debug" variant="secondary" onClick={() => copyDebugInfo(error, scanId, url)}>
        Copy debug info
      </Button>
    ),
  };

  return (
    <section data-testid="error-panel" role="alert" aria-labelledby="error-title" className="mt-6 max-w-[640px] rounded-lg border border-border bg-surface p-5">
      <div className="flex gap-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-well text-text-2" aria-hidden="true">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="error-title" className="pt-1 text-title font-semibold text-text">
            {copy.title}
          </h2>
          {copy.line ? (
            <p data-testid="error-line" className="mt-1 text-body text-text-2">
              {copy.line}
            </p>
          ) : null}
          {error.code === "access-code" ? <AccessCodePrompt /> : null}
          {copy.actions.length ? <div className="mt-4 flex flex-wrap gap-2">{copy.actions.map((action) => buttons[action])}</div> : null}
        </div>
      </div>
    </section>
  );
}
