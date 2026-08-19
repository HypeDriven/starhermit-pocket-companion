/** Offline content validation runner (CI / pre-publish gate). */
import { validateAllContent } from '../src/content.js';
const ok = validateAllContent(console.log);
process.exit(ok ? 0 : 1);
