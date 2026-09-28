import { createLocalScanSource } from "@/agent/source-local";
import type { ScanSource } from "@/agent/types";

/**
 * Where the hosted routes get their scans. It is always the local source: on the server "local" means this function,
 * driving the v1 engine and Chromium as `/api/scan` does. The override exists so the route tests can hand it a scan
 * without a browser, like `setBudgetStoreForTests` does for the budget.
 */

let override: ScanSource | null = null;

export function setAgentScanSourceForTests(source: ScanSource | null): void {
  override = source;
}

export const agentScanSource = (): ScanSource => override ?? createLocalScanSource();
