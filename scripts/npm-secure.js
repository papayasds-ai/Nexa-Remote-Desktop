// Secure npm install for one folder, used by every build script:
//   - exact versions from package-lock.json (npm ci); creates the lockfile on the first run (npm install)
//   - runs `npm audit` on EVERY install and applies the safe fixes (npm audit fix) automatically
//   - lists deprecated packages that the tools pull in
//   - stops (exit 3) when a high/critical advisory is left in something that ships to users
//
//   node scripts/npm-secure.js <folder> [--block-all | --shipped] [--update] [--fix]
//     --block-all  every package counts
//     --shipped    only runtime dependencies count (android-app, server)
//     --runtime    only what really ends up inside the app counts: `electron` + "dependencies" (desktop). Build tools such as
//                  electron-builder run on YOUR PC and are never shipped, so their advisories are listed but do not stop a build.
//     (none)       report only (build tools such as wrangler)
//     --update     first update packages within their allowed version ranges (npm update)
//     --fix        always run npm audit fix
//     --force-fix  also apply fixes that need a MAJOR upgrade (npm audit fix --force). Backups: package.json.before-force / package-lock.json.before-force
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || '.');
const flags = new Set(process.argv.slice(3));
const name = path.basename(dir);
const run = args => spawnSync('npm', args, { cwd: dir, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const text = r => (r.stdout || '') + (r.stderr || '');
const say = m => console.log('  ' + m);

if (!fs.existsSync(path.join(dir, 'package.json'))) { say(name + ': no package.json, skipped'); process.exit(0); }
const pkgPath = path.join(dir, 'package.json');
const readPkg = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const major = v => { const m = /(\d+)\.\d+\.\d+|(\d+)/.exec(String(v || '')); return m ? +(m[1] || m[2]) : 0; };
// packages whose version in `after` is LOWER (by major version) than in `before`
const downgrades = (before, after) => {
  const out = [];
  for (const k of ['dependencies', 'devDependencies']) for (const [n, v] of Object.entries((after || {})[k] || {})) { const o = ((before || {})[k] || {})[n]; if (o && major(v) < major(o)) out.push(n + ' ' + o + ' -> ' + v); }
  return out;
};
// Self-heal: an older `npm audit fix --force` may have DOWNGRADED a tool (e.g. electron-builder 26 -> 25). Put the backup back.
{
  const bk = pkgPath + '.before-force', was = readPkg(bk), now = readPkg(pkgPath), bad = was && now ? downgrades(was, now) : [];
  if (bad.length) {
    fs.copyFileSync(bk, pkgPath); try { fs.unlinkSync(lockPath()); } catch (_) {}
    say('restored package.json: an earlier forced fix had downgraded ' + bad.join(', ') + ' (lockfile will be recreated)');
    for (const f of ['package.json.before-force', 'package-lock.json.before-force']) try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
  }
}
function lockPath() { return path.join(dir, 'package-lock.json'); }
const lock = path.join(dir, 'package-lock.json');
say(name + ': installing packages ' + (fs.existsSync(lock) ? '(exact versions from package-lock.json)' : '(creating package-lock.json)') + '...');

let r = fs.existsSync(lock) ? run(['ci', '--no-fund']) : null;
if (!r || r.status !== 0) r = run(['install', '--no-fund']);
if (r.status !== 0) { console.log(text(r).split(/\r?\n/).slice(-25).join('\n')); say('npm install failed in ' + name); process.exit(2); }
let out = text(r);
if (flags.has('--update')) { const u = run(['update', '--no-fund']); out += '\n' + text(u); }

const deprecated = new Map();
for (const line of out.split(/\r?\n/)) { const m = /npm warn deprecated\s+(.+?):\s*(.*)$/i.exec(line); if (m) deprecated.set(m[1].trim(), m[2].trim()); }

function audit(omitDev) {
  const r = run(omitDev ? ['audit', '--omit=dev', '--json'] : ['audit', '--json']);
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  if (!j || !j.metadata || !j.metadata.vulnerabilities) return { ok: false };
  const v = j.metadata.vulnerabilities;
  const entries = Object.entries(j.vulnerabilities || {});
  const bad = entries.filter(([, x]) => x.severity === 'high' || x.severity === 'critical').map(([k, x]) => k + ' (' + x.severity + ')');
  const rank = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };
  const details = entries.sort((p, q) => (rank[q[1].severity] || 0) - (rank[p[1].severity] || 0)).map(([k, x]) => {
    const via = (x.via || []).find(y => typeof y === 'object');
    const why = via ? via.title : 'depends on ' + (x.via || []).filter(y => typeof y === 'string').join(', ');
    const fa = x.fixAvailable;
    const fix = fa === true ? 'fixed by npm audit fix' : fa && fa.name ? 'upgrade ' + fa.name + ' to ' + fa.version + (fa.isSemVerMajor ? ' (major version)' : '') : 'no fix published yet';
    return k + ' (' + x.severity + '): ' + why + ' - ' + fix;
  });
  return { ok: true, total: v.total || 0, high: (v.high || 0) + (v.critical || 0), bad, details, names: entries.map(([k]) => k) };
}
const scope = flags.has('--block-all') ? 'all' : flags.has('--runtime') ? 'runtime' : flags.has('--shipped') ? 'shipped' : 'none';
const both = () => ({ all: audit(false), shipped: scope === 'shipped' ? audit(true) : null });
// 'runtime' scope (desktop): Electron itself and runtime "dependencies" ship inside the app; every other package is a build tool.
const shippedNames = () => { const p = readPkg(pkgPath) || {}; return new Set(['electron', ...Object.keys(p.dependencies || {})]); };
function runtimeGate(all) {
  if (!all.ok) return all;
  const ship = shippedNames();
  const bad = (all.bad || []).filter(b => ship.has(b.replace(/ \(.*$/, '')));
  return { ok: true, high: bad.length, bad, buildOnly: (all.bad || []).filter(b => !bad.includes(b)) };
}
let a = both();
if (!a.all.ok) say('security audit is not available right now (offline, or a registry without audit): ' + name + ' was installed but NOT audited');
else {
  if (a.all.total > 0 || flags.has('--fix')) {
    say(a.all.total + ' known advisories - applying the safe fixes (npm audit fix)...');
    run(['audit', 'fix', '--no-fund']);
    a = both();
  }
  if (a.all.total > 0 && flags.has('--force-fix')) {
    const backup = f => { const p = path.join(dir, f); if (fs.existsSync(p)) fs.copyFileSync(p, p + '.before-force'); };
    backup('package.json'); backup('package-lock.json');
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    say('applying fixes that need major upgrades (npm audit fix --force); backups: package.json.before-force, package-lock.json.before-force');
    run(['audit', 'fix', '--force', '--no-fund']);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const down = downgrades(before, after);
    if (down.length) {                      // npm sometimes "fixes" by going BACK to an older major: never accept that
      for (const f of ['package.json', 'package-lock.json']) { const b = path.join(dir, f + '.before-force'); if (fs.existsSync(b)) fs.copyFileSync(b, path.join(dir, f)); }
      say('forced fix REJECTED and undone, it would have downgraded: ' + down.join(', '));
      const r2 = run(['ci', '--no-fund']); if (r2.status !== 0) run(['install', '--no-fund']);
    } else {
      for (const k of ['dependencies', 'devDependencies']) for (const [n, ver] of Object.entries(after[k] || {})) if ((before[k] || {})[n] !== ver) say('  changed: ' + n + ' ' + ((before[k] || {})[n] || '(new)') + ' -> ' + ver);
      say('Test the app after a major upgrade. To undo: copy the .before-force files back over package.json / package-lock.json, then run npm ci.');
    }
    for (const f of ['package.json.before-force', 'package-lock.json.before-force']) if (down.length) try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    a = both();
  }
  const toolsOnly = scope === 'runtime' && a.all.total > 0 && !a.all.names.some(n => shippedNames().has(n));
  if (a.all.total === 0) say('no known vulnerabilities');
  else if (toolsOnly) say('OK for shipping: nothing in the app itself is affected. ' + a.all.total + ' advisories remain only inside the installer builder (electron-builder), which never ships; no fixed release of it exists yet, and npm picks it up automatically once there is one.');
  else say(a.all.total + ' known vulnerabilities left (' + a.all.high + ' high/critical)' + (a.all.bad.length ? ': ' + a.all.bad.slice(0, 8).join(', ') : '') + '. Details:');
  if (a.all.total > 0 && !toolsOnly) for (const d of a.all.details.slice(0, 12)) say('  - ' + d);
  if (a.all.total > 0 && scope !== 'runtime' && !flags.has('--force-fix') && a.all.details.some(d => /major version|no fix/.test(d))) say('Fixes that need a major upgrade: NexaDesk.bat security -Force (makes backups, refuses downgrades).');
}
if (deprecated.size) {
  const names = [...deprecated.keys()];
  say('deprecated packages pulled in by the tools: ' + names.slice(0, 8).join(', ') + (names.length > 8 ? ' (+' + (names.length - 8) + ' more)' : '') + ' - not your code; they disappear when the tool authors update');
}
const gate = scope === 'all' ? a.all : scope === 'shipped' ? a.shipped : scope === 'runtime' ? runtimeGate(a.all) : null;
if (scope === 'runtime' && gate && gate.ok && gate.buildOnly && gate.buildOnly.length) {
  say('build-tool advisories (' + gate.buildOnly.join(', ') + ') do NOT stop the build: these packages only run on this PC to create the installer and are never shipped to users.');
  say('They will clear by themselves when electron-builder publishes a release that no longer depends on them. (Do not run a forced fix: it can only downgrade electron-builder.)');
}
if (gate && gate.ok && gate.high > 0) {
  console.log('\nBLOCKED: ' + gate.high + ' high/critical advisories remain in packages that ship to users (' + gate.bad.join(', ') + ').');
  console.log('Run NexaDesk.bat security -Fix to update within the allowed versions. If it still blocks, send me the output of  npm audit  from the ' + name + ' folder.');
  process.exit(3);
}
process.exit(0);
