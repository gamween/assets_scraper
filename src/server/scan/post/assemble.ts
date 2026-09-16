import { NotImplementedError } from "@/server/errors";
import type { AssetsOutput, PostInput } from "../types";

export function assembleAssets(input: PostInput): Promise<AssetsOutput>;
export async function assembleAssets(): Promise<AssetsOutput> {
  throw new NotImplementedError("C: assembleAssets");
}
