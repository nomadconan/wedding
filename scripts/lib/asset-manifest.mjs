// Reads lib/assets/manifest.ts (the single source of truth) from plain Node.
//
// Node 20 LTS cannot import TypeScript, so instead of duplicating the slot list
// into a JSON file we extract the ASSETS object literal from the .ts source and
// evaluate it. The literal is intentionally kept to plain string/number values so
// this stays a pure data read.
//
// Console output in scripts/ stays ASCII-only: Windows CMD (docs/06 section 3)
// runs on a legacy codepage and mangles non-ASCII output.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const MANIFEST_FILE = path.join(ROOT, "lib", "assets", "manifest.ts");

const LITERAL_START = "export const ASSETS = {";
const LITERAL_END = "\n} as const satisfies";

const REQUIRED_FIELDS = ["id", "path", "width", "height", "alt"];

/**
 * @returns {Array<{id:string,path:string,width:number,height:number,alt:string,note?:string}>}
 */
export function loadAssets() {
  const source = readFileSync(MANIFEST_FILE, "utf8");

  const start = source.indexOf(LITERAL_START);
  const end = source.indexOf(LITERAL_END, start);
  if (start === -1 || end === -1) {
    throw new Error(
      `Cannot locate the ASSETS object literal in ${MANIFEST_FILE}. ` +
        `It must be declared as "${LITERAL_START} ... ${LITERAL_END.trim()} Record<string, AssetSlot>;".`,
    );
  }

  // Slice from the opening brace through the matching closing brace.
  const literal = source.slice(start + LITERAL_START.length - 1, end + 2);

  let parsed;
  try {
    parsed = new Function(`"use strict"; return (${literal});`)();
  } catch (error) {
    throw new Error(`Failed to parse the ASSETS literal: ${error.message}`);
  }

  const slots = [];
  for (const [key, slot] of Object.entries(parsed)) {
    for (const field of REQUIRED_FIELDS) {
      if (slot[field] === undefined || slot[field] === "") {
        throw new Error(`Slot "${key}" is missing the required field "${field}".`);
      }
    }
    if (slot.id !== key) {
      throw new Error(`Slot "${key}" has a mismatched id field "${slot.id}".`);
    }
    slots.push(slot);
  }

  if (slots.length === 0) {
    throw new Error("The ASSETS manifest is empty.");
  }
  return slots;
}

/** Absolute path on disk for a slot's public URL path. */
export function diskPath(slot) {
  return path.join(PUBLIC_DIR, ...slot.path.replace(/^\//, "").split("/"));
}

/** File extension without the dot, lower-cased. */
export function extOf(slot) {
  return path.extname(slot.path).slice(1).toLowerCase();
}
