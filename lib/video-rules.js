export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const BITRATE_LIMIT = 3_000_000;
export const FPS_LIMIT = 30.5;
export const LONG_EDGE_LIMIT = 1920;
export const SHORT_EDGE_LIMIT = 1080;

export function parseFps(rateStr) {
  if (typeof rateStr !== 'string' || !rateStr.includes('/')) return null;
  const [num, den] = rateStr.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) {
    return null;
  }
  return num / den;
}

function toEven(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function targetSize(width, height) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(LONG_EDGE_LIMIT / long, SHORT_EDGE_LIMIT / short, 1);
  return {
    width: toEven(width * scale),
    height: toEven(height * scale),
  };
}

export function needsCompress({ width, height, fps, bitrate }) {
  const reasons = [];
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long > LONG_EDGE_LIMIT || short > SHORT_EDGE_LIMIT) reasons.push('resolution');
  if (Number.isFinite(fps) && fps > FPS_LIMIT) reasons.push('fps');
  if (Number.isFinite(bitrate) && bitrate > BITRATE_LIMIT) reasons.push('bitrate');
  return reasons;
}
