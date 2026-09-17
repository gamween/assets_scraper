import type { Asset, FontFamily, FontFormat, FoundIn, HiddenReason, ScanEvent, Tone, WarningCode } from "@/lib/contract";

export interface ScanBackend {
  scan(input: { url: string }, options: { signal: AbortSignal }): AsyncIterable<ScanEvent>;
}

export interface Rect { x: number; y: number; width: number; height: number }

export interface CandidateContext {
  header: boolean;
  nav: boolean;
  footer: boolean;
  homeLink: boolean;
  logoWord: boolean;
  siteWord: boolean;
  logoWall: boolean;
  shadowRoot: boolean;
  iframe: boolean;
}

export interface RawCandidate {
  url: string;                              // absolute http(s), data: or blob: URL
  group: number;                            // element group (src, srcset, picture, image-set)
  foundIn: FoundIn;
  descriptor?: { w?: number; x?: number };
  media?: string;                           // art-directed <source media>
  type?: string;                            // <source type>, <link type>
  sizes?: string;                           // <link sizes>
  order: number;
  visible: boolean;
  rect?: Rect;
  naturalWidth?: number;
  naturalHeight?: number;
  label?: string;                           // aria-label, title, alt, data-framer-name
  linkText?: string;
  context: CandidateContext;
  declaredOnly: boolean;
}

export interface RawSvg {
  markup: string;
  hash: string;
  source: "inline" | "sprite-symbol";
  referenced: boolean;
  order: number;
  visible: boolean;
  rect?: Rect;
  label?: string;
  linkText?: string;
  context: CandidateContext;
  usedCount: number;
  hasLiveText: boolean;
  elementCount: number;
}

export interface RawFontFaceRule {
  family: string;
  src: { url?: string; local?: string; format?: string }[];
  weight: string;
  style: string;
  stretch?: string;
  unicodeRange?: string;
  baseUrl: string;
  origin: "cssom" | "network";
}

export interface RawFontStatus {
  family: string;
  weight: string;
  style: string;
  stretch: string;
  status: "loaded" | "unloaded" | "loading" | "error";
}

export interface RawFontUsage { stack: string; weight: string; style: string; chars: number }

export interface CollectorOptions {
  host: string;
  siteName: string;
  timeBudgetMs: number;
  maxElements: number;
  maxSvgNormalizations: number;
  maxSvgBytes: number;
  maxSvgTotalBytes: number;
  spriteFetchMs: number;                    // external sprite fetch (spec 8.6)
  maxBrandLinks: number;                    // spec 8.1
  maxBlobBytes: number;                     // bytes of one `blob:` image before base64 (spec 7.4, limits.blobMaxBytes)
  maxBlobTotalBytes: number;                // all `blobs` together before base64 (spec 7.4, limits.blobTotalBytes)
  maxOutputChars: number;                   // JSON characters of the whole output; lists are cut to fit (limits.collectorMaxOutputChars)
}

export interface RawCollectorOutput {
  page: { title: string; siteName?: string; baseUrl: string; elementCount: number };
  candidates: RawCandidate[];
  svgs: RawSvg[];
  manifestUrl?: string;
  fontFaces: RawFontFaceRule[];
  fontStatuses: RawFontStatus[];
  fontUsage: RawFontUsage[];
  unreadableSheets: string[];
  blobs: { url: string; mime: string; base64: string }[];
  brandLinks: { href: string; text: string }[];
  noise: Partial<Record<HiddenReason, number>>;
  stats: { elements: number; ms: number; truncated: boolean };
}

export interface FontBinaryMeta {
  format: FontFormat;
  familyName?: string;
  subfamilyName?: string;
  fullName?: string;
  postscriptName?: string;
  typoFamily?: string;
  wwsFamily?: string;
  nameId1?: string;
  copyright?: string;
  licenseDescription?: string;
  licenseUrl?: string;
  axes?: { tag: string; min: number; max: number; default: number }[];
  weightClass?: number;
  coversLatin?: boolean;
}

export interface CapturedImage {
  url: string;
  status: number;
  contentType: string;
  server?: string;
  bytes?: number;
  sha1?: string;
  width?: number;
  height?: number;
  tone: Tone;
  svgText?: string;
  blobBase64?: string;
}

export interface CapturedFont {
  url: string;
  status: number;
  contentType: string;
  bytes?: number;
  sha1?: string;
  meta: FontBinaryMeta | null;
}

export interface CapturedSheet { url: string; status: number; cssText: string }

export interface CapturedNetwork {
  images: CapturedImage[];
  fonts: CapturedFont[];
  sheets: CapturedSheet[];
  bodyTimeouts: number;
  skippedBodies: number;
}

export interface PageContext {
  requestedUrl: string;
  finalUrl: string;
  host: string;
  siteName: string;
  title: string;
}

export interface Signer {
  sign(url: string): string;
  readonly count: number;
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Headers;
  redirected: boolean;
  stream(): ReadableStream<Uint8Array>;
  buffer(): Promise<Buffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  cancel(): Promise<void>;
}

export type SafeFetch = (url: string, options?: SafeFetchOptions) => Promise<SafeResponse>;

export interface PostInput {
  collector: RawCollectorOutput;
  network: CapturedNetwork;
  page: PageContext;
  signer: Signer;
  fetch: SafeFetch;
  signal: AbortSignal;
  deadline: number;                 // epoch ms
}

export interface AssetsOutput { assets: Asset[]; hidden: Partial<Record<HiddenReason, number>>; warnings: WarningCode[] }
export interface FontsOutput { families: FontFamily[]; hidden: Partial<Record<HiddenReason, number>> }
