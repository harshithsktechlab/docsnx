#!/usr/bin/env node
/**
 * Regenerates src/data/indiaPlaces.json — the states and cities behind the
 * profile's Place of Birth dropdowns.
 *
 * Source: GeoNames (https://www.geonames.org), CC BY 4.0. Download into a
 * scratch directory, unzip, then pass both files:
 *
 *   curl -O https://download.geonames.org/export/dump/cities1000.zip
 *   curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
 *   unzip cities1000.zip
 *   node scripts/generate_india_places.mjs <dir>/cities1000.txt <dir>/admin1CodesASCII.txt
 *
 * `cities1000` is every populated place with 1,000+ people. Output shape:
 *   { source, states: [{ code, name }], cities: [[name, stateCode], …] }
 * with both lists sorted by name.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [citiesFile, admin1File] = process.argv.slice(2);
if (!citiesFile || !admin1File) {
  console.error('usage: node scripts/generate_india_places.mjs <cities1000.txt> <admin1CodesASCII.txt>');
  process.exit(1);
}

const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

const states = [];
for (const line of readFileSync(admin1File, 'utf8').split('\n')) {
  const [key, name] = line.split('\t');
  if (key?.startsWith('IN.') && name) states.push({ code: key.slice(3), name });
}
states.sort((a, b) => byName(a.name, b.name));
const known = new Set(states.map((s) => s.code));

const seen = new Set();
const cities = [];
for (const line of readFileSync(citiesFile, 'utf8').split('\n')) {
  const cols = line.split('\t');
  // 1 name, 6 feature class, 8 country code, 10 admin1 code
  if (cols[8] !== 'IN' || cols[6] !== 'P' || !known.has(cols[10])) continue;
  const name = cols[1].trim();
  const key = `${name.toLowerCase()}|${cols[10]}`;
  if (!name || seen.has(key)) continue;
  seen.add(key);
  cities.push([name, cols[10]]);
}
cities.sort((a, b) => byName(a[0], b[0]));

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'indiaPlaces.json');
writeFileSync(out, JSON.stringify({
  source: 'GeoNames (geonames.org), CC BY 4.0',
  states,
  cities,
}));
console.log(`Wrote ${states.length} states and ${cities.length} cities to ${out}`);
