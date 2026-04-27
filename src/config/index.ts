/**
 * Config module — re-exports verbosity configuration system.
 */
export type { PresetName, VerbosityConfig } from './verbosity.js';
export { getPreset, loadConfig, mergeConfig, VerbosityConfigSchema } from './verbosity.js';
