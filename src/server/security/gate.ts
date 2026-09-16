import { NotImplementedError } from "@/server/errors";

export type GateResult = { ok: true; url: string; host: string; ops: boolean } | { ok: false; response: Response };

export function gateScanRequest(request: Request): Promise<GateResult>;
export async function gateScanRequest(): Promise<GateResult> {
  throw new NotImplementedError("A: gateScanRequest");
}
