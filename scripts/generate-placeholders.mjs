// Generates placeholder images for every slot in lib/assets/manifest.ts.
//
//   npm run assets:gen
//
// Rules:
// - Never overwrites an existing file. Dropping the real artwork in at the same
//   path is how a slot gets filled; re-running this script leaves it alone.
// - No new dependency: PNGs go through scripts/lib/png-writer.mjs, SVGs are text.
// - Every placeholder prints its slot id and its "1600x900" dimensions.
//
// Console output is ASCII-only for Windows CMD (docs/06 section 3).

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadAssets, diskPath, extOf } from "./lib/asset-manifest.mjs";
import {
  createCanvas,
  drawCenteredText,
  drawDiagonals,
  strokeRect,
  encodePng,
  fitScale,
  GLYPH_HEIGHT,
} from "./lib/png-writer.mjs";

const COLORS = {
  background: [241, 242, 244],
  diagonal: [223, 226, 230],
  border: [199, 203, 209],
  text: [90, 101, 114],
};

const SVG = {
  background: "#F1F2F4",
  diagonal: "#DFE2E6",
  border: "#C7CBD1",
  text: "#5A6572",
};

function dimsLabel(slot) {
  return `${slot.width}x${slot.height}`;
}

function renderPng(slot) {
  const { width, height } = slot;
  const canvas = createCanvas(width, height, COLORS.background);

  drawDiagonals(canvas, Math.max(1, Math.round(Math.min(width, height) / 240)), COLORS.diagonal);
  strokeRect(canvas, 0, 0, width, height, Math.max(1, Math.round(Math.min(width, height) / 120)), COLORS.border);

  const id = slot.id;
  const dims = dimsLabel(slot);
  const filename = path.basename(slot.path);

  // Scale the id line to ~72% of the width, then cap it so tall/narrow slots
  // do not end up with text taller than the box.
  const idScale = Math.max(
    1,
    Math.min(fitScale(id, width * 0.72), Math.floor((height * 0.18) / GLYPH_HEIGHT)),
  );
  const dimScale = Math.max(1, Math.min(Math.round(idScale * 0.7), fitScale(dims, width * 0.5)));
  const fileScale = Math.max(1, Math.min(Math.round(idScale * 0.42), fitScale(filename, width * 0.86)));

  const gap = Math.max(2, Math.round(idScale * 2.2));
  const block = GLYPH_HEIGHT * (idScale + dimScale + fileScale) + gap * 2;
  let y = Math.round((height - block) / 2);

  drawCenteredText(canvas, id, y, idScale, COLORS.text);
  y += GLYPH_HEIGHT * idScale + gap;
  drawCenteredText(canvas, dims, y, dimScale, COLORS.text);
  y += GLYPH_HEIGHT * dimScale + gap;
  drawCenteredText(canvas, filename, y, fileScale, COLORS.text);

  return encodePng(canvas);
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSvg(slot) {
  const { width, height, id } = slot;
  const dims = dimsLabel(slot);
  const stroke = Math.max(1, Math.round(Math.min(width, height) / 120));

  // Rough advance width for a sans-serif digit/letter is ~0.62em.
  const fitWidth = (text) => Math.floor((width * 0.8) / (text.length * 0.62));

  // Two stacked lines need about 3.2x the font size of vertical room.
  const idSize = Math.min(fitWidth(id), Math.floor(height / 3.2));
  const lines = [];
  if (idSize >= 5) {
    lines.push(
      `  <text x="50%" y="46%" font-family="system-ui, sans-serif" font-size="${idSize}" ` +
        `fill="${SVG.text}" text-anchor="middle" dominant-baseline="middle">${escapeXml(id)}</text>`,
      `  <text x="50%" y="46%" dy="${Math.round(idSize * 1.5)}" font-family="system-ui, sans-serif" ` +
        `font-size="${Math.max(4, Math.round(idSize * 0.8))}" fill="${SVG.text}" text-anchor="middle" ` +
        `dominant-baseline="middle">${dims}</text>`,
    );
  } else {
    // The id will not fit legibly (small icon slots). Print the dimensions only —
    // the <title> above still carries the id for screen readers and grep.
    const dimSize = Math.max(4, Math.min(fitWidth(dims), Math.floor(height / 1.8)));
    lines.push(
      `  <text x="50%" y="50%" font-family="system-ui, sans-serif" font-size="${dimSize}" ` +
        `fill="${SVG.text}" text-anchor="middle" dominant-baseline="middle">${dims}</text>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(slot.alt)}">`,
    `  <title>${escapeXml(id)} ${dims} (placeholder)</title>`,
    `  <rect width="${width}" height="${height}" fill="${SVG.background}"/>`,
    `  <path d="M0 0 L${width} ${height} M${width} 0 L0 ${height}" stroke="${SVG.diagonal}" stroke-width="${stroke}"/>`,
    `  <rect x="${stroke / 2}" y="${stroke / 2}" width="${width - stroke}" height="${height - stroke}" ` +
      `fill="none" stroke="${SVG.border}" stroke-width="${stroke}"/>`,
    ...lines,
    "</svg>",
    "",
  ].join("\n");
}

function main() {
  const slots = loadAssets();
  let created = 0;
  let kept = 0;

  for (const slot of slots) {
    const target = diskPath(slot);
    if (existsSync(target)) {
      kept += 1;
      console.log(`kept    ${slot.path}`);
      continue;
    }

    const ext = extOf(slot);
    let content;
    if (ext === "png") {
      content = renderPng(slot);
    } else if (ext === "svg") {
      content = renderSvg(slot);
    } else {
      console.error(`ERROR   ${slot.id}: unsupported extension ".${ext}" (png or svg only)`);
      process.exitCode = 1;
      continue;
    }

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    created += 1;
    console.log(`created ${slot.path}  (${dimsLabel(slot)})`);
  }

  console.log(`\n${slots.length} slots: ${created} created, ${kept} already present.`);
  if (created > 0) {
    console.log("Run: npm run assets:check");
  }
}

main();
