// Render the browser extension icons (16/32/48/128 PNG) from an SVG with playwright. usage: node render_icons.js <svg> <outdir>
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
(async () => {
  const [svgPath, out] = process.argv.slice(2), svg = fs.readFileSync(svgPath, 'utf8');
  const b = await chromium.launch(), p = await b.newPage();
  for (const n of [16, 32, 48, 128]) {
    await p.setViewportSize({ width: n, height: n });
    await p.setContent(`<html><body style="margin:0;background:transparent"><img style="width:${n}px;height:${n}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`);
    await p.waitForTimeout(100);
    await p.screenshot({ path: path.join(out, `${n}.png`), omitBackground: true });
  }
  await b.close(); console.log('icons ok');
})();
