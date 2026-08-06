// Verifies that every slot in lib/assets/manifest.ts has a file on disk whose
// real dimensions match the manifest.
//
//   npm run assets:check
//
// Exits non-zero on any failure so T-02b can wire it into the CI gate.
// Console output is ASCII-only for Windows CMD (docs/06 section 3).

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadAssets, diskPath, extOf, PUBLIC_DIR } from "./lib/asset-manifest.mjs";
import { readPngSize } from "./lib/png-writer.mjs";

const IMAGES_DIR = path.join(PUBLIC_DIR, "images");

/** Reads width/height from the root <svg> element's attributes. */
function readSvgSize(text) {
  const openTag = text.match(/<svg\b[^>]*>/i);
  if (!openTag) return null;
  const width = openTag[0].match(/\bwidth\s*=\s*"([\d.]+)(?:px)?"/i);
  const height = openTag[0].match(/\bheight\s*=\s*"([\d.]+)(?:px)?"/i);
  if (!width || !height) return null;
  return { width: Number(width[1]), height: Number(height[1]) };
}

function readSize(file, ext) {
  if (ext === "png") return readPngSize(readFileSync(file));
  if (ext === "svg") return readSvgSize(readFileSync(file, "utf8"));
  return null;
}

/** Every file under public/images, as public URL paths. */
function walkImages(dir, collected = []) {
  if (!existsSync(dir)) return collected;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkImages(full, collected);
    } else {
      collected.push("/" + path.relative(PUBLIC_DIR, full).split(path.sep).join("/"));
    }
  }
  return collected;
}

function main() {
  const slots = loadAssets();
  const errors = [];
  const warnings = [];
  const seenPaths = new Map();

  for (const slot of slots) {
    const ext = extOf(slot);
    const file = diskPath(slot);

    if (seenPaths.has(slot.path)) {
      errors.push(`${slot.id}: path collides with slot "${seenPaths.get(slot.path)}" (${slot.path})`);
    }
    seenPaths.set(slot.path, slot.id);

    if (!slot.path.startsWith("/images/")) {
      errors.push(`${slot.id}: path must start with /images/ (got ${slot.path})`);
      continue;
    }
    if (ext !== "png" && ext !== "svg") {
      errors.push(`${slot.id}: unsupported extension ".${ext}" (png or svg only)`);
      continue;
    }

    // Naming rule: {screen}-{slot}@{W}x{H}.{ext} (docs/ASSETS.md)
    const stamped = path.basename(slot.path).match(/@(\d+)x(\d+)\.[a-z]+$/i);
    if (!stamped) {
      errors.push(`${slot.id}: filename must encode its size as @${slot.width}x${slot.height} (${path.basename(slot.path)})`);
    } else if (Number(stamped[1]) !== slot.width || Number(stamped[2]) !== slot.height) {
      errors.push(
        `${slot.id}: filename says @${stamped[1]}x${stamped[2]} but the manifest says ${slot.width}x${slot.height}`,
      );
    }

    if (!existsSync(file)) {
      errors.push(`${slot.id}: file is missing -> public${slot.path}   (run: npm run assets:gen)`);
      continue;
    }

    const size = readSize(file, ext);
    if (!size) {
      errors.push(
        `${slot.id}: cannot read the dimensions of public${slot.path}` +
          (ext === "svg" ? ' (the root <svg> needs explicit width="" and height="")' : " (not a valid PNG)"),
      );
      continue;
    }
    if (size.width !== slot.width || size.height !== slot.height) {
      errors.push(
        `${slot.id}: file is ${size.width}x${size.height} but the manifest says ${slot.width}x${slot.height} -> public${slot.path}`,
      );
      continue;
    }

    console.log(`ok      ${slot.id.padEnd(24)} ${slot.width}x${slot.height}  ${slot.path}`);
  }

  // Files under public/images that no slot references. Not fatal: they may be
  // sources or exports, but they are invisible to the app, so flag them.
  const orphans = walkImages(IMAGES_DIR).filter((file) => !seenPaths.has(file));
  for (const orphan of orphans) {
    warnings.push(`unreferenced file (no manifest slot points at it): public${orphan}`);
  }

  console.log("");
  for (const warning of warnings) console.log(`WARN    ${warning}`);
  for (const error of errors) console.error(`FAIL    ${error}`);

  if (errors.length > 0) {
    console.error(`\n${slots.length} slots checked, ${errors.length} failed.`);
    process.exit(1);
  }
  console.log(`${slots.length} slots checked, all passed.${warnings.length ? ` ${warnings.length} warning(s).` : ""}`);
}

main();
