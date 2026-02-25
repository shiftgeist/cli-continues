import chalk from 'chalk';

/**
 * ASCII art banner with warm-to-cool gradient and highlighted 's' brand mark.
 * All letters are exactly 4 chars wide, 1-space separated, 3 rows.
 */
export function showBanner(version: string, supportsColor: boolean): void {
  if (!supportsColor) return;

  // Letter glyphs: [top, mid, bot], each 4 chars wide
  const glyphs: string[][] = [
    ['\u2588\u2580\u2580\u2580', '\u2588   ', '\u2580\u2580\u2580\u2580'], // c
    ['\u2588\u2580\u2580\u2588', '\u2588  \u2588', '\u2580\u2580\u2580\u2580'], // o
    ['\u2588\u2580\u2580\u2584', '\u2588  \u2588', '\u2580  \u2580'], // n
    ['\u2580\u2588\u2588\u2580', ' \u2588\u2588 ', ' \u2580\u2580 '], // t
    [' \u2588\u2588 ', ' \u2588\u2588 ', ' \u2580\u2580 '], // i
    ['\u2588\u2580\u2580\u2584', '\u2588  \u2588', '\u2580  \u2580'], // n
    ['\u2588  \u2588', '\u2588  \u2588', '\u2580\u2580\u2580\u2580'], // u
    ['\u2588\u2580\u2580\u2588', '\u2588\u2580\u2580 ', '\u2580\u2580\u2580\u2580'], // e
    ['\u2588\u2580\u2580\u2580', '\u2580\u2580\u2580\u2588', '\u2580\u2580\u2580\u2580'], // s
  ];

  // Gradient: coral -> orange -> gold -> emerald -> blue -> sky -> purple -> mint
  const colors = [
    chalk.hex('#FF6B6B'),        // c — coral
    chalk.hex('#FF8E53'),        // o — orange
    chalk.hex('#FFA940'),        // n — amber
    chalk.hex('#FFD93D'),        // t — gold
    chalk.hex('#6BCB77'),        // i — emerald
    chalk.hex('#4D96FF'),        // n — blue
    chalk.hex('#38B6FF'),        // u — sky
    chalk.hex('#6C5CE7'),        // e — purple
    chalk.hex('#00FFC8').bold,   // s — mint
  ];

  console.log();
  for (let row = 0; row < 3; row++) {
    let line = '  ';
    for (let i = 0; i < glyphs.length; i++) {
      line += colors[i](glyphs[i][row]);
      if (i < glyphs.length - 1) line += ' ';
    }
    console.log(line);
  }
  console.log();
  console.log('  ' + chalk.bold.white('v' + version) + chalk.gray(' — never lose context across ') + chalk.cyan('14 AI coding agents'));
  console.log();
  console.log('  ' + chalk.gray('🔄 Cross-tool handoff') + chalk.gray(' · ') + chalk.gray('🔎 Inspect mode') + chalk.gray(' · ') + chalk.gray('⚙️  YAML config') + chalk.gray(' · ') + chalk.gray('🌍 Env var overrides'));
  console.log('  ' + chalk.gray('💡 cont <n> or continues <tool> to quick-resume'));
  console.log();
}
