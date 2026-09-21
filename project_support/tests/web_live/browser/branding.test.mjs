import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const web = new URL('../../../../user_application/web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');

test('loading screen and map overlay use the supplied local logo with accessible text and intrinsic dimensions', () => {
  const loading = html.match(/<h1 id="loading-title"[\s\S]*?<\/h1>/)?.[0];
  assert.doesNotMatch(html,/<header\b/);
  const overlay = html.match(/<div id="attribution"[\s\S]*?<\/div>\s*<\/div>/)?.[0];
  for (const markup of [loading, overlay]) {
    // The display asset first, the untouched original as the fallback source,
    // with the display resolution as the intrinsic size so nothing reflows.
    assert.match(markup, /<source[^>]*srcset="\/static\/branding\/aerodt-1520\.webp"[^>]*type="image\/webp"/);
    assert.match(markup, /<img[^>]*src="\/static\/branding\/aerodt.png"[^>]*alt="AERODT"[^>]*width="1520"[^>]*height="508"/);
  }
  assert.match(css, /\.brand-mark\{[^}]*width:74px[^}]*height:auto/);
  assert.match(loading,/class="loading-logo"/);
  assert.match(overlay, /title="Developed by KADA"/);
  assert.match(overlay, /KADA/);
  assert.match(overlay, /id="map-credits"/);
});

test('brand logo is bundled as the original transparent PNG, not a downloads dependency',()=>{
  const png=readFileSync(new URL('branding/aerodt.png',web));
  assert.equal(png.subarray(1,4).toString(),'PNG');
  assert.equal(png.readUInt32BE(16),2170);assert.equal(png.readUInt32BE(20),725);
  assert.equal(png[25],6,'RGBA transparency');
  assert.doesNotMatch(html,/Downloads|file:\/\//);
});

test('tab uses the uppercase product name and a local teal favicon', () => {
  assert.match(html, /<title>AERODT — Live Twin<\/title>/);
  assert.match(html, /rel="icon"[^>]*href="\/static\/favicon\.svg/);
  const icon = readFileSync(new URL('favicon.svg', web), 'utf8');
  assert.match(icon, /<svg/);
  assert.match(icon, /#65e3db/);
});

test('removing the corner brand leaves no null header writes and preserves fixture labeling',()=>{
  const app=readFileSync(new URL('app.js',web),'utf8');
  assert.doesNotMatch(app,/header \.eyebrow|textIfChanged\(eyebrow/);
  assert.match(html,/id="data-mode"[^>]*hidden[^>]*>TEST \/ NOT LIVE/);
  assert.match(app,/\$\('data-mode'\)\.hidden=!fixture/);
});

test('the maker mark stays small enough to sit over the map on a phone',()=>{
  assert.match(css,/@media\(max-width:700px\)\{\.brand-mark\{width:58px\}\}/);
  assert.ok(74*725/2170 < 26, 'the mark is a corner overlay, not a bar');
  assert.doesNotMatch(css,/--footer-height/);
});

test('the brand is served at display resolution, and is held until it is whole so it never wipes in from the top',()=>{
  const webp=readFileSync(new URL('branding/aerodt-1520.webp',web));
  const png=readFileSync(new URL('branding/aerodt.png',web));
  assert.equal(webp.subarray(0,4).toString(),'RIFF');assert.equal(webp.subarray(8,12).toString(),'WEBP');
  assert.equal(webp.subarray(12,16).toString(),'VP8L','lossless: the brand keeps every visible pixel');
  const header=webp.readUInt32LE(21);
  assert.equal((header & 0x3fff)+1,1520);assert.equal(((header>>14) & 0x3fff)+1,508);
  assert.ok(webp.length<png.length*.5,`the streamed brand is at most half the original (${webp.length} of ${png.length})`);
  assert.ok(1520>=760*2,'enough for a 2x display at the 760 px layout width');

  const loadingCss=readFileSync(new URL('loading.css',web),'utf8');
  for(const [name,selector] of [['loading-logo',/\.loading-logo\{[^}]*opacity:0/],['loading-content',/\.loading-content\{[^}]*opacity:0/]]){
    assert.match(loadingCss,selector,`${name} is held: a streaming image paints top-down`);
    assert.match(loadingCss,new RegExp(`\\.${name}\\[data-ready=true\\]\\{opacity:1;animation:none\\}`));
    assert.match(loadingCss,new RegExp(`animation:${name}-whole 1ms linear 4s forwards`),'a delayed keyframe reveals it even if the script never runs');
    assert.match(loadingCss,new RegExp(`@keyframes ${name}-whole\\{to\\{opacity:1\\}\\}`));
  }

  assert.match(html,/<img id="loading-logo"/);
  assert.match(html,/<link rel="preload" as="image" href="\/static\/branding\/aerodt-1520\.webp" type="image\/webp" fetchpriority="high">/,
    'the brand fetch starts with the document, not after the stylesheet');
  const app=readFileSync(new URL('app.js',web),'utf8');
  assert.doesNotMatch(app,/revealWhenWhole/,'the reveal runs inline: waiting for the module chain would hold the screen blank longer than the image does');
});

// The reveal is inline in the document, so run that exact source here.
function bootstrap(image,content){
  const source=html.match(/<script id="brand-reveal">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source,'the reveal bootstrap is present in the document');
  const document={getElementById:id=>id==='loading-logo'?image:null,querySelector:selector=>selector==='.loading-content'?content:null};
  new Function('document',source)(document);
}
test('the brand and the text are revealed together, only once the image is whole',async()=>{
  let settle;const image={dataset:{},decode(){return new Promise((resolve,reject)=>{settle={resolve,reject};});}};
  const content={dataset:{}};
  bootstrap(image,content);
  await Promise.resolve();
  assert.equal(image.dataset.ready,undefined,'still streaming: nothing is shown yet');
  assert.equal(content.dataset.ready,undefined,'the text does not appear first and wait for the brand');
  settle.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(image.dataset.ready,'true');assert.equal(content.dataset.ready,'true');
});
test('a brand that never decodes still shows the screen rather than leaving it blank',async()=>{
  const broken={dataset:{},decode(){return Promise.reject(new Error('404'));}},content={dataset:{}};
  bootstrap(broken,content);
  await Promise.resolve();await Promise.resolve();
  assert.equal(broken.dataset.ready,'true','alt text beats a blank screen');
  assert.equal(content.dataset.ready,'true');

  const throwing={dataset:{},decode(){throw new Error('unsupported');}},thrownContent={dataset:{}};
  bootstrap(throwing,thrownContent);
  assert.equal(thrownContent.dataset.ready,'true','a synchronous failure reveals at once');

  const noDecode={dataset:{}},oldContent={dataset:{}};
  bootstrap(noDecode,oldContent);
  assert.equal(noDecode.dataset.ready,'true');assert.equal(oldContent.dataset.ready,'true');

  const orphan={dataset:{}};
  bootstrap(null,orphan);
  assert.equal(orphan.dataset.ready,'true','a missing image must never leave the screen blank');
});
