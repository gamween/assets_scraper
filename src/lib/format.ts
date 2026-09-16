const BYTE_UNITS = ["KB", "MB", "GB", "TB"];

/** 1024-based sizes: one decimal below 10 ("3.0 KB", "2.4 MB"), whole numbers from 10 ("352 KB", "250 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 999.5) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  // Switch units before rounding would print 1000 or more ("1024 KB" becomes "1.0 MB").
  while (value >= 999.5 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value < 9.95 ? `${value.toFixed(1)} ${BYTE_UNITS[unit]}` : `${Math.round(value)} ${BYTE_UNITS[unit]}`;
}

export function formatDimensions(width?: number, height?: number): string {
  return width && height ? `${Math.round(width)}×${Math.round(height)}` : "";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "1,500", or with a noun "1 asset", "48 assets", "2 files". */
export function formatCount(count: number, singular?: string, plural = `${singular}s`): string {
  if (!Number.isFinite(count)) return "";
  const text = COUNT.format(count);
  return singular ? `${text} ${Math.abs(count) === 1 ? singular : plural}` : text;
}
