/**
 * Clipboard writes that work in Safari: it rejects `navigator.clipboard.write` unless the call happens synchronously
 * inside the click or key handler, so text that still needs fetching goes in as a Promise inside a ClipboardItem.
 * Call these functions from the handler itself, before any await.
 */

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  document.body.append(area);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or no focus: try the legacy path below.
  }
  return legacyCopy(text);
}

/** Copies text that is still loading (for example the markup of a remote SVG file). */
export async function copyTextFrom(text: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    } catch {
      // Fall through: the page may have lost focus while the text loaded.
    }
  }
  try {
    return await copyText(await text);
  } catch {
    return false;
  }
}
