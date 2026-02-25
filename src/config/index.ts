/**
 * Config module — re-exports verbosity configuration system.
 */
export type { PresetName, VerbosityConfig } from './verbosity.js';
export { VerbosityConfigSchema, getPreset, loadConfig, mergeConfig } from './verbosity.js';
