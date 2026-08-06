/**
 * A minimal QR encoder, enough for an otpauth:// enrolment URI.
 *
 * Written here rather than pulled in because the alternative was worse in both
 * available forms: a hosted chart API would send the user's TOTP secret to a
 * third party, and a general-purpose QR dependency brings kanji modes, image
 * encoders and a much larger surface to audit for the one thing we need.
 *
 * Scope is deliberately narrow and the code says so where it matters:
 *   * Byte mode only. An otpauth URI is mixed-case ASCII with punctuation, so
 *     the numeric and alphanumeric modes cannot encode it anyway.
 *   * Version chosen from a table, up to version 10 with error correction
 *     level L — comfortably more than a ~120-character enrolment URI needs.
 *   * Mask pattern 0, fixed. A proper encoder scores all eight and picks the
 *     best; at this size every scanner reads pattern 0 fine, and choosing it
 *     unconditionally removes the scoring code and its bugs.
 *
 * If a caller ever needs QR for something larger, replace this rather than
 * extend it.
 */

/**
 * Block structure by version, for error correction level L.
 *
 * `blocks` is why this table exists rather than a simple capacity number: from
 * version 5 upward the data is split, each block gets its own Reed-Solomon
 * tail, and the codewords are interleaved before placement. Getting that wrong
 * produces a code that looks plausible and scans as nothing.
 *
 * Stops at version 6 deliberately. Version 7 adds an eighteen-bit version
 * information block in two more corners of the matrix — another piece of the
 * spec to implement and another way to be silently wrong — and an enrolment
 * URI fits comfortably below it.
 */
const BLOCKS_L: Readonly<Record<number, { blocks: number; dataPerBlock: number; eccPerBlock: number }>> = {
  1: { blocks: 1, dataPerBlock: 19, eccPerBlock: 7 },
  2: { blocks: 1, dataPerBlock: 34, eccPerBlock: 10 },
  3: { blocks: 1, dataPerBlock: 55, eccPerBlock: 15 },
  4: { blocks: 1, dataPerBlock: 80, eccPerBlock: 20 },
  5: { blocks: 1, dataPerBlock: 108, eccPerBlock: 26 },
  6: { blocks: 2, dataPerBlock: 68, eccPerBlock: 18 },
};

const MAX_VERSION = 6;

const ALIGNMENT_CENTRES: Readonly<Record<number, number[]>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};

/* ── GF(256) arithmetic for Reed-Solomon ─────────────────────────────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // The QR field polynomial.
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j]!, EXP[i]!);
      next[j + 1] = (next[j + 1] ?? 0) ^ poly[j]!;
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: number[], eccCount: number): number[] {
  const gen = generatorPoly(eccCount);
  const remainder = new Array<number>(eccCount).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < eccCount; i++) {
      remainder[i] = remainder[i]! ^ gfMul(gen[i + 1]!, factor);
    }
  }

  return remainder;
}

/* ── Matrix construction ─────────────────────────────────────────────────── */

type Grid = (0 | 1 | null)[][];

function placeFinder(grid: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= grid.length || cc >= grid.length) continue;
      const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const on =
        inRing &&
        (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      grid[rr]![cc] = on ? 1 : 0;
    }
  }
}

function placeAlignment(grid: Grid, version: number): void {
  const centres = ALIGNMENT_CENTRES[version] ?? [];
  for (const r of centres) {
    for (const c of centres) {
      // Skip the three corners already occupied by finder patterns.
      if ((r === 6 && c === 6) || (r === 6 && c === centres[centres.length - 1]) ||
          (r === centres[centres.length - 1] && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          grid[r + dr]![c + dc] = on ? 1 : 0;
        }
      }
    }
  }
}

/** Format information for error correction L and the fixed mask 0. */
function placeFormat(grid: Grid): void {
  const size = grid.length;
  // ECC level L = 01, mask 0 = 000 → 01000, with the standard BCH tail and
  // XOR mask 101010000010010 applied. Precomputed: nothing here varies.
  const bits = 0b111011111000100;

  for (let i = 0; i < 15; i++) {
    const bit = ((bits >> i) & 1) as 0 | 1;

    // Around the top-left finder.
    if (i < 6) grid[i]![8] = bit;
    else if (i === 6) grid[7]![8] = bit;
    else if (i === 7) grid[8]![8] = bit;
    else if (i === 8) grid[8]![7] = bit;
    else grid[8]![14 - i] = bit;

    // The duplicate copy, split across the other two finders.
    if (i < 8) grid[8]![size - 1 - i] = bit;
    else grid[size - 15 + i]![8] = bit;
  }

  grid[size - 8]![8] = 1; // Always-dark module.
}

function isReserved(grid: Grid, row: number, col: number): boolean {
  return grid[row]![col] !== null;
}

/** Mask 0: invert where (row + column) is even. */
function maskBit(row: number, col: number): number {
  return (row + col) % 2 === 0 ? 1 : 0;
}

/**
 * Encode a string as a QR matrix of booleans, `true` meaning a dark module.
 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));

  // 4 bits mode + 8 bits length + payload, rounded up to whole codewords.
  const needed = Math.ceil((4 + 8 + bytes.length * 8) / 8);

  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const layout = BLOCKS_L[v]!;
    if (layout.blocks * layout.dataPerBlock >= needed) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new Error(
      `QR payload of ${bytes.length} bytes exceeds what this encoder supports (version ${MAX_VERSION}, level L)`,
    );
  }

  const layout = BLOCKS_L[version]!;
  const dataCount = layout.blocks * layout.dataPerBlock;

  // ── Bit stream ──────────────────────────────────────────────────────────
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // Byte mode.
  push(bytes.length, 8); // Length, 8 bits for versions 1-9 in byte mode.
  for (const b of bytes) push(b, 8);

  // Terminator, then pad to a byte boundary.
  const capacityBits = dataCount * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    codewords.push(byte);
  }

  // The two alternating pad codewords the spec mandates.
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCount; i++) codewords.push(PAD[i % 2]!);

  // ── Blocks, each with its own Reed-Solomon tail ─────────────────────────
  // Splitting the data means a burst of damage lands in one block rather than
  // overwhelming a single correction budget. The order on the matrix is
  // interleaved for the same reason.
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  for (let b = 0; b < layout.blocks; b++) {
    const block = codewords.slice(b * layout.dataPerBlock, (b + 1) * layout.dataPerBlock);
    dataBlocks.push(block);
    eccBlocks.push(reedSolomon(block, layout.eccPerBlock));
  }

  const allCodewords: number[] = [];
  for (let i = 0; i < layout.dataPerBlock; i++) {
    for (const block of dataBlocks) if (i < block.length) allCodewords.push(block[i]!);
  }
  for (let i = 0; i < layout.eccPerBlock; i++) {
    for (const block of eccBlocks) if (i < block.length) allCodewords.push(block[i]!);
  }

  // ── Matrix ──────────────────────────────────────────────────────────────
  const size = version * 4 + 17;
  const grid: Grid = Array.from({ length: size }, () => new Array<0 | 1 | null>(size).fill(null));

  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);
  placeAlignment(grid, version);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const bit = (i % 2 === 0 ? 1 : 0) as 0 | 1;
    if (grid[6]![i] === null) grid[6]![i] = bit;
    if (grid[i]![6] === null) grid[i]![6] = bit;
  }

  placeFormat(grid);

  // ── Data placement: two columns at a time, right to left, boustrophedon ──
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    if (right === 6) right = 5;

    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (const col of [right, right - 1]) {
        if (isReserved(grid, row, col)) continue;

        const byte = allCodewords[bitIndex >> 3] ?? 0;
        const bit = (byte >> (7 - (bitIndex & 7))) & 1;
        bitIndex++;

        grid[row]![col] = ((bit ^ maskBit(row, col)) === 1 ? 1 : 0) as 0 | 1;
      }
    }
    upward = !upward;
  }

  return grid.map((row) => row.map((cell) => cell === 1));
}

/**
 * Render as a standalone SVG string.
 *
 * Path-based rather than one `<rect>` per module: a version-5 code is 37×37,
 * and 1,369 elements is a lot of DOM for something the user looks at once.
 */
export function qrSvg(text: string, options: { size?: number; quietZone?: number } = {}): string {
  const matrix = qrMatrix(text);
  const modules = matrix.length;
  const quiet = options.quietZone ?? 4; // The spec's minimum quiet zone.
  const total = modules + quiet * 2;
  const pixel = options.size ?? 232;

  let path = "";
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (matrix[r]![c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  // Light background drawn explicitly: a transparent QR on a dark theme is
  // unscannable, and this is shown in a UI that has both.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixel}" height="${pixel}"`,
    ` viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img"`,
    ` aria-label="Two-factor enrolment QR code">`,
    `<rect width="${total}" height="${total}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    `</svg>`,
  ].join("");
}
