import type { Tone } from "@/lib/contract";
import { NotImplementedError } from "@/server/errors";

export function toneFromBytes(buffer: Buffer, contentType: string): Promise<Tone>;
export async function toneFromBytes(): Promise<Tone> {
  throw new NotImplementedError("C: toneFromBytes");
}

export function toneFromSvg(markup: string): Promise<Tone>;
export async function toneFromSvg(): Promise<Tone> {
  throw new NotImplementedError("C: toneFromSvg");
}
