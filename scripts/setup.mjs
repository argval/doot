import { access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import process from "node:process";

const requiredMajor = 20;
const detectedMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (detectedMajor < requiredMajor) {
  console.error(`Doot requires Node.js ${requiredMajor}+; found ${process.versions.node}.`);
  process.exit(1);
}

try {
  await access(".env", constants.F_OK);
  console.log("Using existing .env file.");
} catch {
  await copyFile(".env.example", ".env");
  console.log("Created .env from .env.example. Add provider credentials when you are ready.");
}

console.log("Doot is set up. Run `npm run db:migrate` if you want a local Turso file, then `npm run dev`.");
