import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const replacement = process.argv[3];
const original = readFileSync(path, "utf8");
const patched = original.replace(/�+/g, replacement);
writeFileSync(path, patched, "utf8");
console.log("remaining:", patched.includes("�"));
