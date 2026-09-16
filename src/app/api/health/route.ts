export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return new Response("Not implemented", { status: 501 });
}
