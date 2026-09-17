/**
 * Size variant merging (spec 8.3), ported from the discovery lab: union-find over image URLs.
 */

export interface VariantMember {
  url: string;
  kind: "svg" | "raster";
  groups: number[];           // element groups the URL belongs to, in order of appearance
  preferredGroup?: number;    // first group where it is a srcset, image-set or type-only <source> candidate
  artDirectedOnly?: boolean;  // only found as an art-directed <source media>: never merged through its group
  key?: string;               // variantKey (http(s) URLs only)
  sha1?: string;              // sha1 of captured bytes
}

/**
 * Groups members that share an element group, a variant key or captured bytes, then splits each group by raster vs
 * SVG. A URL used by several elements (a shared fallback `src`) only joins its preferred group, so it cannot chain
 * unrelated images together. Groups and their members keep input order.
 */
export function groupVariants<T extends VariantMember>(members: T[]): T[][] {
  const parent = members.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const byGroup = new Map<number, number>();
  const byKey = new Map<string, number>();
  const byHash = new Map<string, number>();
  const link = <K>(index: Map<K, number>, value: K, i: number) => {
    const first = index.get(value);
    if (first === undefined) index.set(value, i);
    else union(i, first);
  };

  members.forEach((member, i) => {
    if (!member.artDirectedOnly && member.groups.length) {
      const preferred = member.groups.length > 1 ? (member.preferredGroup ?? member.groups[0]) : member.groups[0];
      link(byGroup, preferred, i);
    }
    if (member.key) link(byKey, member.key, i);
    if (member.sha1) link(byHash, member.sha1, i);
  });

  const out = new Map<string, T[]>();
  members.forEach((member, i) => {
    const id = `${find(i)}|${member.kind}`;
    const group = out.get(id);
    if (group) group.push(member);
    else out.set(id, [member]);
  });
  return [...out.values()];
}

export interface SizeHints {
  width?: number;             // decoded from captured or probed bytes
  height?: number;
  naturalWidth?: number;      // decoded in the page
  naturalHeight?: number;
  declaredWidth?: number;     // manifest `sizes`, <link sizes>
  declaredHeight?: number;
  descriptorW?: number;       // largest srcset `w`
  descriptorX?: number;       // largest srcset `x`
  bytes?: number;
}

const area = (width?: number, height?: number) => (width && height ? width * height : 0);

/** Pixel area of the best size evidence: decoded, then natural, declared, `w` descriptor, `x` descriptor, then bytes. */
export function sizeScore(m: SizeHints): number {
  return (
    area(m.width, m.height) ||
    area(m.naturalWidth, m.naturalHeight) ||
    area(m.declaredWidth, m.declaredHeight) ||
    (m.descriptorW ? m.descriptorW * m.descriptorW * 0.6 : 0) ||
    m.descriptorX ||
    (m.bytes ?? 0) / 1e6
  );
}

/** The largest member; the first one wins ties. */
export function pickBest<T extends SizeHints>(members: T[]): T {
  return members.reduce((best, member) => (sizeScore(member) > sizeScore(best) ? member : best));
}
