// Inlined from package.json at build time (tsup/esbuild bundles the JSON;
// the named import keeps only this field), so it can never drift from the
// published version.
import { version } from '../package.json';

export const VERSION: string = version;
