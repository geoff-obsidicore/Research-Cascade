/**
 * Server entry point — re-exports startServer for CLI use.
 * Separated so the CLI can dynamically import only when needed.
 */
export { startServer as default } from './index.js';
