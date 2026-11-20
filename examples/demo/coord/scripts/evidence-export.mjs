process.stderr.write("DEPRECATED: coord/scripts/evidence-export.mjs is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/evidence-export.mjs instead.\n");
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../engine/scripts/evidence-export.mjs";

export * from "../engine/scripts/evidence-export.mjs";
export { default } from "../engine/scripts/evidence-export.mjs";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) engine.main();
