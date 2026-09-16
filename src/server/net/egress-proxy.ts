import { NotImplementedError } from "@/server/errors";

export interface EgressProxy {
  port: number;
  stats(): { bytes: number; blocked: number; blockedHosts: string[] };
  close(): Promise<void>;
}

export function startEgressProxy(options?: { maxBytes?: number; maxSockets?: number }): Promise<EgressProxy>;
export async function startEgressProxy(): Promise<EgressProxy> {
  throw new NotImplementedError("A: startEgressProxy");
}
