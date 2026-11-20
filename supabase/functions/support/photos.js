const MAX_IMAGE_LENGTH = 400_000;
const MAX_SIDE = 1280;
const MAX_BODY_LENGTH = 1_250_000;

/** Read a JSON request without buffering an unbounded body. */
export async function readTicketJson(req) {
  const reader = req.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_LENGTH) {
        await reader.cancel();
        throw new RangeError('ticket request too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

/** Validate the JPEG frame and dimensions before storing an untrusted attachment. */
export function validTicketPhoto(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_LENGTH || !value.startsWith('/9j/')) return false;
  let image;
  try { image = atob(value); }
  catch { return false; }
  const byte = (index) => image.charCodeAt(index);
  const word = (index) => (byte(index) << 8) + byte(index + 1);
  if (image.length < 32 || word(image.length - 2) !== 0xffd9) return false;

  let hasFrame = false;
  let offset = 2;
  while (offset + 3 < image.length) {
    if (byte(offset++) !== 0xff) return false;
    while (byte(offset) === 0xff) offset++;
    const marker = byte(offset++);
    const length = word(offset);
    if (length < 2 || offset + length > image.length - 2) return false;
    if (marker === 0xda) return hasFrame;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (hasFrame || length < 11 || byte(offset + 2) !== 8) return false;
      const height = word(offset + 3);
      const width = word(offset + 5);
      if (Math.min(width, height) < 1 || Math.max(width, height) > MAX_SIDE) return false;
      hasFrame = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xcc].includes(marker)) {
      return false;
    }
    offset += length;
  }
  return false;
}
