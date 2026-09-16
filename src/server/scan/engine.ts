import { NotImplementedError } from "@/server/errors";
import type { ScanBackend } from "./types";

export const scanEngine: ScanBackend = {
  scan() {
    throw new NotImplementedError("B: scanEngine");
  },
};
