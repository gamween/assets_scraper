import type { SafeFetch, SafeFetchOptions, SafeResponse } from "@/server/scan/types";

export function fakeResponse(url: string, status: number, body = ""): SafeResponse {
  return {
    url,
    status,
    headers: new Headers({ "content-type": "text/css" }),
    redirected: false,
    stream: () => new Response(body).body!,
    buffer: async () => Buffer.from(body),
    text: async () => body,
    json: async () => JSON.parse(body),
    cancel: async () => {},
  };
}

export interface FakeGoogleFetch extends SafeFetch {
  calls: { url: string; options?: SafeFetchOptions }[];
}

/** A `SafeFetch` for the Google Fonts CSS API that answers 200 for `families` and 400 for any other family. */
export function fakeGoogleFetch(families: string[]): FakeGoogleFetch {
  const calls: FakeGoogleFetch["calls"] = [];
  const fetch = async (url: string, options?: SafeFetchOptions) => {
    calls.push({ url, options });
    const family = new URL(url).searchParams.get("family");
    return fakeResponse(url, family && families.includes(family) ? 200 : 400);
  };
  return Object.assign(fetch, { calls });
}
