import { NotImplementedError } from "@/server/errors";

export interface BlockInput {
  status: number;
  title: string;
  html: string;
  headers: Record<string, string>;
  elementCount: number;
}

export function detectBlock(input: BlockInput): string | null;
export function detectBlock(): string | null {
  throw new NotImplementedError("B: detectBlock");
}
