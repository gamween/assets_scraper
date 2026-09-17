export const runtime = "nodejs";

/** Build SHA and switches, never URLs or secrets (spec 16). */
export function GET(): Response {
  return Response.json(
    {
      ok: true,
      version: process.env.VERCEL_GIT_COMMIT_SHA || "dev",
      disabled: process.env.SCAN_DISABLED === "1",
      accessCode: Boolean(process.env.ACCESS_CODE),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
