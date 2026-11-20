export const MAX_TICKET_PHOTOS = 3;
const MAX_ENCODED_LENGTH = 400_000;
const JPEG_PREFIX = 'data:image/jpeg;base64,';

export const ticketPhotoSrc = (image) => JPEG_PREFIX + image;

export async function prepareTicketPhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
    throw new Error('Choose a JPG, PNG or WebP image up to 12 MB');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (const maxSide of [1280, 1024]) {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.72, 0.55]) {
        const url = canvas.toDataURL('image/jpeg', quality);
        if (!url.startsWith(JPEG_PREFIX)) throw new Error();
        if (url.length <= MAX_ENCODED_LENGTH + JPEG_PREFIX.length) return url.slice(JPEG_PREFIX.length);
      }
    }
  } catch {
    throw new Error('Could not read this photo');
  } finally {
    bitmap?.close();
  }
  throw new Error('The attached photos are too large.');
}
