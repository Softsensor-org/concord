process.stderr.write("DEPRECATED: coord/scripts/dispatch.mjs is a legacy shim and will be removed in 0.3.0. Use coord/engine/scripts/dispatch.mjs instead.\n");
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../engine/scripts/dispatch.mjs";

export * from "../engine/scripts/dispatch.mjs";
export { default } from "../engine/scripts/dispatch.mjs";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) engine.main();
