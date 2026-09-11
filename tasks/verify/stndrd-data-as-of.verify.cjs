const fs = require('fs');

const must = ['src/components/DataAsOf.tsx', 'src/app/page.tsx', 'src/app/attendance/page.tsx'];
for (const f of must) {
  if (!fs.existsSync(f)) {
    console.error('missing ' + f);
    process.exit(1);
  }
}

const [c, o, a] = must.map((f) => fs.readFileSync(f, 'utf8'));

const checks = [
  ['fmtDateFull reused in DataAsOf.tsx', /fmtDateFull/.test(c)],
  ['"Data as of" copy present', /Data as of/.test(c)],
  ['isoDate typed as string | null', /string\s*\|\s*null/.test(c)],
  ['DataAsOf referenced on Overview page', /DataAsOf/.test(o)],
  ['DATA_AS_OF referenced on Overview page', /DATA_AS_OF/.test(o)],
  ['DataAsOf referenced on Attendance page', /DataAsOf/.test(a)],
  ['DATA_AS_OF referenced on Attendance page', /DATA_AS_OF/.test(a)],
  ['no "use client" directive in DataAsOf.tsx', !/["']use client["']/.test(c)]
];

const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
if (failed.length) {
  console.error('task requirements not satisfied:\n- ' + failed.join('\n- '));
  process.exit(1);
}
