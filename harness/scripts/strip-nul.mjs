import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const original = readFileSync(path, "utf8");
const count = original.split("\u0000").length - 1;
const patched = original.split("\u0000").join("\\u0000");
writeFileSync(path, patched, "utf8");
const after = readFileSync(path, "utf8");
console.log("NUL before:", count, "after:", after.includes("\u0000"));
console.log(
  after
    .split("\n")
    .filter((line) => line.includes("u0000"))
    .join("\n"),
);
