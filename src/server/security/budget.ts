import { NotImplementedError } from "@/server/errors";

export interface BudgetStore {
  incr(key: string, by: number, ttlSeconds: number): Promise<number>;
}

export function getBudgetStore(): BudgetStore {
  throw new NotImplementedError("A: getBudgetStore");
}

export function setBudgetStoreForTests(store: BudgetStore | null): void;
export function setBudgetStoreForTests(): void {
  throw new NotImplementedError("A: setBudgetStoreForTests");
}

export function takeScanBudget(now?: Date): Promise<boolean>;
export async function takeScanBudget(): Promise<boolean> {
  throw new NotImplementedError("A: takeScanBudget");
}

export function takeProxyBytes(bytes: number, now?: Date): Promise<boolean>;
export async function takeProxyBytes(): Promise<boolean> {
  throw new NotImplementedError("A: takeProxyBytes");
}
