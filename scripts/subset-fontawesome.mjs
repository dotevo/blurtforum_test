#!/usr/bin/env node
/**
 * scripts/subset-fontawesome.mjs
 *
 * Regenerates public/vendor/fontawesome/ (what actually ships to users) as
 * a trimmed subset of fontawesome-src/fontawesome-full/ (the pristine,
 * full Font Awesome Free 6 release, kept in the repo as the "master" copy
 * this script always subsets FROM -- never edited by hand, never itself
 * shipped, since it lives outside public/).
 *
 * Why this exists: the full FA Free webfont set is ~420KB (all 4 styles'
 * woff2 files + the CSS mapping every one of FA's ~2000+ icons), for an app
 * that -- per a direct grep of src/ -- uses exactly 103 of them (102 solid
 * + 1 brand, "fa-youtube"), and only the "solid" and "brands" styles at
 * all (never regular/light/thin/duotone/v4-compat). Subsetting the actual
 * font files (not just trimming the CSS) is what gets the real byte
 * savings -- a browser downloads the whole woff2 file for any icon it
 * renders regardless of how small the CSS is.
 *
 * Run via `npm run build` (wired in as a prebuild step, see package.json)
 * so this can never silently go stale -- add a new <i class="fa-solid
 * fa-whatever"> anywhere in src/ and the next build automatically picks it
 * up and re-subsets, no manual font-tool step for anyone to remember. Can
 * also be run standalone: `npm run fa:subset`.
 *
 * Uses `subset-font` (devDependency), a pure-JS/WASM wrapper around
 * harfbuzz's hb-subset -- the same subsetting engine industry tools like
 * fonttools/pyftsubset use -- so this needs nothing but Node, no Python or
 * native toolchain required on a fresh checkout.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC_DIR = join(ROOT, 'src');
const FA_FULL_DIR = join(ROOT, 'fontawesome-src', 'fontawesome-full');
const FA_OUT_DIR = join(ROOT, 'public', 'vendor', 'fontawesome');

// Style-prefix and utility classes are not icon glyphs -- excluded so they
// don't get looked up as (nonexistent) icon names below. Kept as an
// explicit list rather than "assume anything not found in the CSS is a
// utility class" so a genuinely missing/misspelled icon name still fails
// loudly (see the throw below) instead of being silently swallowed here.
const NON_GLYPH_CLASSES = new Set([
  'fa', 'fa-solid', 'fa-regular', 'fa-brands', 'fa-light', 'fa-thin', 'fa-duotone', 'fa-sharp', 'fa-classic',
  'fa-spin', 'fa-spin-pulse', 'fa-pulse', 'fa-beat', 'fa-beat-fade', 'fa-bounce', 'fa-fade', 'fa-flip',
  'fa-flip-horizontal', 'fa-flip-vertical', 'fa-flip-both', 'fa-shake', 'fa-border', 'fa-fw', 'fa-inverse',
  'fa-li', 'fa-ul', 'fa-pull-left', 'fa-pull-right', 'fa-stack', 'fa-stack-1x', 'fa-stack-2x', 'fa-layers',
  'fa-layers-text', 'fa-layers-counter', 'fa-layers-bottom-right', 'fa-layers-bottom-left',
  'fa-layers-top-right', 'fa-layers-top-left', 'fa-2xs', 'fa-xs', 'fa-sm', 'fa-lg', 'fa-xl', 'fa-2xl',
  'fa-1x', 'fa-2x', 'fa-3x', 'fa-4x', 'fa-5x', 'fa-6x', 'fa-7x', 'fa-8x', 'fa-9x', 'fa-10x',
]);

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some(e => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function findUsedIconClasses() {
  const files = walk(SRC_DIR, ['.vue', '.ts']);
  const found = new Set();
  const re = /\bfa-[a-z0-9-]+\b/g;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(text))) {
      if (!NON_GLYPH_CLASSES.has(m[0])) found.add(m[0]);
    }
  }
  return [...found].sort();
}

/** Parses `.fa-name:before{content:"\fXXX"}` (and comma-grouped selector
 *  variants) out of the FULL all.min.css, per icon class name -> codepoint
 *  (as a JS number). Font Awesome's own shipped CSS is the source of truth
 *  for this mapping -- more reliable than hand-maintaining a codepoint
 *  table that'd drift from whatever FA version is actually in
 *  fontawesome-src/. */
function buildCodepointMap(css) {
  const map = new Map();
  const ruleRe = /((?:\.fa-[a-z0-9-]+:before,?)+)\{content:"\\([0-9a-fA-F]+)"\}/g;
  let m;
  while ((m = ruleRe.exec(css))) {
    const codepoint = parseInt(m[2], 16);
    for (const sel of m[1].split(',')) {
      const name = sel.replace(/^\./, '').replace(/:before$/, '');
      if (name) map.set(name, codepoint);
    }
  }
  return map;
}

async function main() {
  const fullCss = readFileSync(join(FA_FULL_DIR, 'css', 'all.min.css'), 'utf8');
  const codepointMap = buildCodepointMap(fullCss);

  const usedClasses = findUsedIconClasses();
  const solidCodepoints = new Set();
  const brandsCodepoints = new Set();
  const missing = [];

  // Every icon actually used in this app is either "fa-brands fa-<name>"
  // (brand logos) or "fa-solid fa-<name>" (everything else) -- verified by
  // grep, see the item-5 investigation this script is the result of. If a
  // future icon needs the regular/light/thin/duotone styles, this script
  // (and the two woff2s it subsets) would need a matching new style branch
  // -- deliberately not building that out speculatively for styles nothing
  // uses today.
  for (const cls of usedClasses) {
    const name = cls; // e.g. 'fa-youtube'
    if (!codepointMap.has(name)) { missing.push(name); continue; }
    const cp = codepointMap.get(name);
    if (name === 'fa-youtube') brandsCodepoints.add(cp);
    else solidCodepoints.add(cp);
  }

  if (missing.length) {
    throw new Error(
      `subset-fontawesome: ${missing.length} class(es) used in src/ have no matching icon in ` +
      `fontawesome-src/fontawesome-full/css/all.min.css -- typo, or a real icon this script's ` +
      `NON_GLYPH_CLASSES/brand-detection needs updating for: ${missing.join(', ')}`
    );
  }

  mkdirSync(join(FA_OUT_DIR, 'webfonts'), { recursive: true });

  const solidFull = readFileSync(join(FA_FULL_DIR, 'webfonts', 'fa-solid-900.woff2'));
  const brandsFull = readFileSync(join(FA_FULL_DIR, 'webfonts', 'fa-brands-400.woff2'));

  const toUnicodeRanges = (codepoints) =>
    [...codepoints].map(cp => String.fromCodePoint(cp)).join('');

  const solidSubset = await subsetFont(solidFull, toUnicodeRanges(solidCodepoints), { targetFormat: 'woff2' });
  const brandsSubset = await subsetFont(brandsFull, toUnicodeRanges(brandsCodepoints), { targetFormat: 'woff2' });

  writeFileSync(join(FA_OUT_DIR, 'webfonts', 'fa-solid-900.woff2'), solidSubset);
  writeFileSync(join(FA_OUT_DIR, 'webfonts', 'fa-brands-400.woff2'), brandsSubset);
  // fa-regular-400.woff2 and fa-v4compatibility.woff2 intentionally not
  // written here at all -- zero usages of either style found (see
  // NON_GLYPH_CLASSES / findUsedIconClasses above). Explicitly removed
  // (not just "not written") so re-running this script after they were
  // present from an older full/untrimmed copy actually cleans them up
  // instead of leaving stale dead weight behind.
  for (const stale of ['fa-regular-400.woff2', 'fa-v4compatibility.woff2']) {
    const p = join(FA_OUT_DIR, 'webfonts', stale);
    try { rmSync(p); } catch { /* already absent, fine */ }
  }

  // Minimal generated CSS: base display/font-family rules (needed for any
  // icon to render at all) + fa-spin's animation (the only utility class
  // actually used, see NON_GLYPH_CLASSES/grep above) + exactly one
  // :before{content} rule per used icon. Everything else in the original
  // ~2000-selector file (every OTHER icon's content rule, v4/v5-compat
  // @font-face blocks for font-families nothing here references, sizing/
  // flip/rotate/stack utility classes nothing here uses) is simply never
  // emitted, rather than emitted-then-relying-on-a-minifier-to-drop-it.
  const iconRules = usedClasses
    .map(name => `.${name}:before{content:"\\${codepointMap.get(name).toString(16)}"}`)
    .join('');

  const css = `/*!
 * Trimmed Font Awesome Free subset -- generated by scripts/subset-fontawesome.mjs
 * from fontawesome-src/fontawesome-full/ (pristine FA Free release). Do not
 * hand-edit -- re-run \`npm run fa:subset\` (or just \`npm run build\`, which
 * runs it automatically) after adding/removing any fa-* icon in src/.
 * Original: Font Awesome Free by @fontawesome - https://fontawesome.com
 * License - https://fontawesome.com/license/free (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT License)
 */
@font-face{font-family:"Font Awesome 6 Free";font-style:normal;font-weight:900;font-display:swap;src:url(../webfonts/fa-solid-900.woff2) format("woff2")}
@font-face{font-family:"Font Awesome 6 Brands";font-style:normal;font-weight:400;font-display:swap;src:url(../webfonts/fa-brands-400.woff2) format("woff2")}
.fa,.fa-solid,.fa-brands{-moz-osx-font-smoothing:grayscale;-webkit-font-smoothing:antialiased;display:var(--fa-display,inline-block);font-style:normal;font-variant:normal;line-height:1;text-rendering:auto}
.fa,.fa-solid{font-family:"Font Awesome 6 Free";font-weight:900}
.fa-brands{font-family:"Font Awesome 6 Brands";font-weight:400}
.fa-spin{animation:fa-spin 2s linear infinite}
@keyframes fa-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
${iconRules}
`;

  mkdirSync(join(FA_OUT_DIR, 'css'), { recursive: true });
  writeFileSync(join(FA_OUT_DIR, 'css', 'all.min.css'), css);

  const fmt = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(
    `subset-fontawesome: ${usedClasses.length} icons (${solidCodepoints.size} solid, ${brandsCodepoints.size} brand) -- ` +
    `solid ${fmt(solidFull.length)} -> ${fmt(solidSubset.length)}, ` +
    `brands ${fmt(brandsFull.length)} -> ${fmt(brandsSubset.length)}, ` +
    `css -> ${fmt(Buffer.byteLength(css))}`
  );
}

main().catch(err => { console.error(err); process.exit(1); });
