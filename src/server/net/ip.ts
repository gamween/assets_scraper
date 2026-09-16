import { NotImplementedError } from "@/server/errors";

export class SsrfError extends Error {
  constructor(readonly reason: "private-ip" | "private-dns" | "own-host" | "dns-failure" | "invalid-host", readonly host: string) {
    super(`${reason}: ${host}`);
    this.name = "SsrfError";
  }
}

export function isPublicIp(ip: string): boolean;
export function isPublicIp(): boolean {
  throw new NotImplementedError("A: isPublicIp");
}

export function isOwnHost(host: string): boolean;
export function isOwnHost(): boolean {
  throw new NotImplementedError("A: isOwnHost");
}

export function isTestAllowed(host: string, port: number): boolean;
export function isTestAllowed(): boolean {
  throw new NotImplementedError("A: isTestAllowed");
}

export function resolvePublicHost(host: string, port: number): Promise<string>;
export async function resolvePublicHost(): Promise<string> {
  throw new NotImplementedError("A: resolvePublicHost");
}
