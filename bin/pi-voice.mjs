#!/usr/bin/env node
/**
 * pi-voice launcher.
 *
 * The CLI is authored in TypeScript (src/cli.ts) and relies on jiti to strip
 * types at runtime. Pointing the bin directly at the .ts file fails once the
 * package is installed under node_modules (e.g. `pi install npm:...`):
 *
 *   1. Node's native type stripping refuses .ts files inside node_modules
 *      (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the file never runs.
 *   2. `--import jiti` loads jiti's main entry, which does NOT register the
 *      TS loader hooks (the correct entry is `jiti/register`), and bare
 *      specifiers resolve against the cwd, not this package.
 *
 * This launcher sidesteps both: it is plain JavaScript (no type stripping
 * needed), resolves jiti relative to THIS file, registers the loader via
 * createJiti(), and only then imports the TypeScript CLI.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
await jiti.import("../src/cli.ts");
