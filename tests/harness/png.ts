import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel. */
  readonly rgba: Uint8ClampedArray;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Minimal PNG decoder for reference screenshots.
 *
 * Handles the subset the Game Boy test suites actually ship — including the 2-bit palette
 * images the acid2 tests use, since four shades need exactly two bits. Non-interlaced only.
 *
 * Written rather than added as a dependency so the test harness stays free of runtime
 * packages.
 */
export function decodePng(data: Buffer): DecodedPng {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (data[i] !== SIGNATURE[i]) throw new Error('Not a PNG file');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      if (body[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`Unsupported colour type ${colorType}`);
  if (bitDepth !== 8 && !(bitDepth <= 4 && (colorType === 0 || colorType === 3))) {
    throw new Error(`Unsupported bit depth ${bitDepth} for colour type ${colorType}`);
  }

  const raw = inflateSync(Buffer.concat(idat));

  // Sub-byte depths pack several pixels per byte; filtering still operates on whole bytes,
  // and its "pixel to the left" distance is at least one byte.
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const filterUnit = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const rawByte = line[x]!;
      const a = x >= filterUnit ? out[x - filterUnit]! : 0;
      const b = prior ? prior[x]! : 0;
      const c = prior && x >= filterUnit ? prior[x - filterUnit]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`Unknown PNG filter ${filter}`);
      }
      out[x] = value & 0xff;
    }
  }

  // Expand packed samples so every sample occupies one byte.
  let samples: Buffer;
  if (bitDepth === 8) {
    samples = pixels;
  } else {
    samples = Buffer.alloc(width * height * channels);
    const perByte = 8 / bitDepth;
    const mask = (1 << bitDepth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width * channels; x++) {
        const byte = pixels[y * stride + Math.floor(x / perByte)]!;
        const shift = 8 - bitDepth * ((x % perByte) + 1);
        samples[y * width * channels + x] = (byte >> shift) & mask;
      }
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dst = i * 4;
    switch (colorType) {
      case 0: {
        const grey = scale(samples[src]!, bitDepth);
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = grey;
        rgba[dst + 3] = 0xff;
        break;
      }
      case 2:
        rgba[dst] = samples[src]!;
        rgba[dst + 1] = samples[src + 1]!;
        rgba[dst + 2] = samples[src + 2]!;
        rgba[dst + 3] = 0xff;
        break;
      case 3: {
        if (!palette) throw new Error('Palette image with no PLTE chunk');
        const index = samples[src]! * 3;
        rgba[dst] = palette[index]!;
        rgba[dst + 1] = palette[index + 1]!;
        rgba[dst + 2] = palette[index + 2]!;
        rgba[dst + 3] = 0xff;
        break;
      }
      case 4:
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = samples[src]!;
        rgba[dst + 3] = samples[src + 1]!;
        break;
      default:
        rgba[dst] = samples[src]!;
        rgba[dst + 1] = samples[src + 1]!;
        rgba[dst + 2] = samples[src + 2]!;
        rgba[dst + 3] = samples[src + 3]!;
        break;
    }
  }

  return { width, height, rgba };
}

/** Scales an n-bit sample to the full 0-255 range. */
function scale(value: number, bitDepth: number): number {
  if (bitDepth === 8) return value;
  const max = (1 << bitDepth) - 1;
  return Math.round((value / max) * 255);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
