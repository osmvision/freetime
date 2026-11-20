import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readTicketJson, validTicketPhoto } from '../functions/support/photos.js';

const jpeg = readFileSync(new URL('../../desktop/ui/img/ideas/advent-of-code.jpg', import.meta.url));

test('support photos accept bounded JPEGs and reject unsupported or oversized frames', () => {
  assert.equal(validTicketPhoto(jpeg.toString('base64')), true);
  assert.equal(validTicketPhoto(jpeg.subarray(0, -2).toString('base64')), false);
  assert.equal(validTicketPhoto('data:image/jpeg;base64,' + jpeg.toString('base64')), false);
  assert.equal(validTicketPhoto('/9j/' + 'A'.repeat(400_000)), false);
  const oversized = Buffer.from(jpeg);
  const frame = oversized.indexOf(Buffer.from([0xff, 0xc2])); // This fixture uses progressive JPEG.
  assert.ok(frame >= 0);
  oversized.writeUInt16BE(8192, frame + 7);
  assert.equal(validTicketPhoto(oversized.toString('base64')), false);
});

test('support JSON preserves UTF-8 and rejects a body above the upload limit', async () => {
  const url = 'https://example.test/support';
  const params = (body) => ({ method: 'POST', body });
  const report = { ticket: { message: 'Voilà le problème.' }, photos: [jpeg.toString('base64')] };
  assert.deepEqual(await readTicketJson(new Request(url, params(JSON.stringify(report)))), report);
  await assert.rejects(readTicketJson(new Request(url, params('x'.repeat(1_250_001)))), RangeError);
});
