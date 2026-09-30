import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
let chromium;
try { ({ chromium } = await import(process.env.VSS_PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const executablePath = process.env.VSS_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const runnable = chromium && existsSync(executablePath);
const root = fileURLToPath(new URL('../public', import.meta.url));
async function browserTest(body) {
  const server = createServer((req, res) => {
    const file = join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', {'.js':'text/javascript','.html':'text/html','.css':'text/css'}[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, resolve));
  const browser = await chromium.launch({executablePath, args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try { const page = await browser.newPage(); page.on('pageerror', e => console.log('PAGE ERROR', e.message)); await page.goto(`http://127.0.0.1:${server.address().port}/`); return await body(page); }
  finally { await browser.close(); server.close(); }
}
const options = {skip:runnable ? false : 'no browser available'};
test('GPU smoothing removes grain but preserves a strong color edge and orientation', options, async () => {
  const result = await browserTest(async page => page.evaluate(async () => {
    const { GlRenderer } = await import('/app/v2/render/gl-renderer.js');
    const source = document.createElement('canvas'); source.width=256; source.height=128;
    const ctx=source.getContext('2d'); const pixels=ctx.createImageData(256,128);
    for(let y=0;y<128;y++) for(let x=0;x<256;x++) {
      const i=(y*256+x)*4, noise=((x*13+y*7)%9)-4;
      pixels.data.set(x<128?[160+noise,70+noise+(y<64?20:0),90+noise,255]:[40+noise,130+noise+(y<64?20:0),90+noise,255],i);
    }
    ctx.putImageData(pixels,0,0);
    const output=document.createElement('canvas'), renderer=new GlRenderer(output);
    const read=enhancement => {
      renderer.uploadHeld(source);
      if(!renderer.render('rgb',{width:256,height:128},undefined,{enhancement})) throw Error(renderer.unavailableReason);
      const copy=document.createElement('canvas');copy.width=256;copy.height=128;
      const c=copy.getContext('2d');c.drawImage(output,0,0);return [...c.getImageData(0,0,256,128).data];
    };
    const original=read(undefined), smooth=read({smoothing:1,sharpness:0,detail:0});
    const flat=read({smoothing:0,sharpness:0,detail:1});
    const variance=a => {
      let sum=0,sum2=0,n=0;
      for(let y=20;y<100;y++)for(let x=20;x<100;x++){const v=a[(y*256+x)*4];sum+=v;sum2+=v*v;n++;}
      return sum2/n-(sum/n)**2;
    };
    return {before:variance(original),after:variance(smooth),left:smooth[(64*256+126)*4],right:smooth[(64*256+129)*4],top:smooth[(24*256+40)*4+1],bottom:smooth[(104*256+40)*4+1],identity:original.every((v,i)=>v===flat[i])};
  }));
  assert.ok(result.after < result.before*0.7,JSON.stringify(result));
  assert.ok(result.left > 145 && result.right < 55,'strong colored boundary survives smoothing');
  assert.equal(result.identity,true,'off is an exact identity');
  assert.ok(result.top>result.bottom+15,'post-processing keeps the top of the image at the top');
});

test('photo quality upgrades to maximum and both selectors stay synchronized', options, async () => {
  await browserTest(async page => {
    await page.evaluate(() => localStorage.setItem('vss.v2.visuallyLossless.v1','yes'));
    await page.reload();
    assert.equal(await page.inputValue('#v2PhotoQuality'),'maximum');
    await page.locator('#v2Dock [data-route="more"]').click();
    await page.selectOption('#v2PhotoQuality','compressed');
    assert.equal(await page.inputValue('#v2ReviewPhotoQuality'),'compressed');
    await page.reload();
    assert.equal(await page.inputValue('#v2PhotoQuality'),'compressed');
    await page.locator('#v2Dock [data-route="more"]').click();
    await page.selectOption('#v2PhotoQuality','maximum');
    assert.equal(await page.inputValue('#v2ReviewPhotoQuality'),'maximum');
  });
});

for (const [width,height] of [[320,568],[430,932],[932,430]]) {
  test(`review retains a visible image and reachable actions at ${width}x${height}`, options, async () => {
    await browserTest(async page => {
      await page.setViewportSize({width,height});
      await page.evaluate(() => {
        document.body.dataset.review='on';
        document.getElementById('v2Review').hidden=false;
        const canvas=document.getElementById('v2ReviewCanvas');canvas.width=600;canvas.height=800;
      });
      const boxes=await page.evaluate(() => {
        const frame=document.querySelector('.review-frame').getBoundingClientRect();
        const actions=document.querySelector('.review-actions').getBoundingClientRect();
        return {frame:{height:frame.height,width:frame.width},actions:{bottom:actions.bottom,top:actions.top},overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.ok(boxes.frame.height>=100,JSON.stringify(boxes));
      assert.ok(boxes.actions.bottom<=height && boxes.actions.top>=0,JSON.stringify(boxes));
      assert.equal(boxes.overflow,false);
    });
  });
}

test('enhancement presets and sliders synchronize, and keep tone independent', options, async () => {
  await browserTest(async page => {
    await page.locator('#v2EnhancementRow [data-enhancement="crisp"]').click();
    assert.equal(await page.inputValue('#v2ReviewEnhancement-smoothing'),'55');
    assert.equal(await page.inputValue('#v2ReviewEnhancement-sharpness'),'85');
    assert.equal(await page.locator('#v2LevelsRow .active').getAttribute('data-levels'),'off');
    await page.locator('#v2EnhancementRow-sharpness').fill('120');
    assert.equal(await page.inputValue('#v2ReviewEnhancement-sharpness'),'120');
    await page.reload();
    assert.equal(await page.inputValue('#v2EnhancementRow-sharpness'),'120');
  });
});

test('maximum-quality export keeps dimensions and matches the enhanced render', options, async () => {
  const result=await browserTest(async page => page.evaluate(async () => {
    const {GlRenderer}=await import('/app/v2/render/gl-renderer.js');
    const {capturePhoto}=await import('/app/v2/capture/photo.js');
    const source=document.createElement('canvas');source.width=128;source.height=96;
    const ctx=source.getContext('2d');
    for(let x=0;x<128;x++) {
      const value=Math.round(70+120*(0.5+0.5*Math.tanh((x-64)/2)));
      ctx.fillStyle=`rgb(${value},${value},${value})`;ctx.fillRect(x,0,1,96);
    }
    ctx.fillStyle='#963966';ctx.fillRect(0,0,16,20);
    const output=document.createElement('canvas'),renderer=new GlRenderer(output);
    const size={width:128,height:96,aspect:128/96,reason:'test source size'};
    const plain=await capturePhoto(renderer,source,'rgb',size);
    const read=()=>{const c=document.createElement('canvas');c.width=128;c.height=96;const x=c.getContext('2d');x.drawImage(output,0,0);return x.getImageData(0,0,128,96).data;};
    const before=read();
    const edited=await capturePhoto(renderer,source,'rgb',size,{enhancement:{smoothing:0.25,sharpness:1.5,detail:0.65}});
    const preview=read();
    const bitmap=await createImageBitmap(edited.blob);
    const decoded=document.createElement('canvas');decoded.width=128;decoded.height=96;const dc=decoded.getContext('2d');dc.drawImage(bitmap,0,0);bitmap.close();
    const bytes=dc.getImageData(0,0,128,96).data;
    let error=0,count=0;for(let i=0;i<bytes.length;i++){if(i%4!==3){error+=Math.abs(preview[i]-bytes[i]);count++;}}
    const edge=a=>a[(48*128+65)*4]-a[(48*128+63)*4];
    const compressed=await capturePhoto(renderer,source,'rgb',size,{visuallyLossless:true});
    return {quality:edited.quality,choice:edited.choice,width:edited.width,height:edited.height,error:error/count,before:edge(before),after:edge(preview),compressed:compressed.quality,searchMs:plain.timing.searchMs};
  }));
  assert.equal(result.quality,1);assert.equal(result.choice,null);
  assert.deepEqual([result.width,result.height],[128,96]);
  assert.ok(result.error<3,JSON.stringify(result));
  assert.ok(result.after>result.before,JSON.stringify(result));
  assert.ok(result.compressed>=0.90);
});

if(process.env.VSS_TEST_IMAGE) test('imported photo edits and original comparison work in both orientations', options, async () => {
  await browserTest(async page=>{
    await page.setViewportSize({width:430,height:932});
    await page.locator('#v2ImportFile').setInputFiles(process.env.VSS_TEST_IMAGE);
    await page.waitForSelector('#v2Review:not([hidden])');
    await page.locator('#v2ReviewEnhancement [data-enhancement="crisp"]').click();
    await page.waitForFunction(()=>document.querySelector('#v2ReviewNote').textContent.startsWith('Held —'),null,{timeout:30000});
    assert.match(await page.locator('#v2ReviewNote').textContent(),/Maximum quality/);
    const compare=page.locator('#v2CompareOriginal');await compare.scrollIntoViewIfNeeded();
    await compare.focus();await page.keyboard.down('Space');
    assert.equal(await page.locator('#v2ReviewOriginal').isVisible(),true);
    await page.keyboard.up('Space');assert.equal(await page.locator('#v2ReviewOriginal').isVisible(),false);
    for(const [w,h] of [[430,932],[320,568],[932,430]]) {
      await page.setViewportSize({width:w,height:h});
      const size=await page.locator('.review-frame').boundingBox();assert.ok(size.height>=100);
      const action=await page.locator('#v2ReviewKeep').boundingBox();assert.ok(action.y+action.height<=h);
      if(process.env.VSS_SCREENSHOTS) await page.screenshot({path:`${process.env.VSS_SCREENSHOTS}/editor-${w}x${h}.png`});
    }
  });
});

test('a preset selected before the shutter is applied when the shot enters review', options, async () => {
  await browserTest(async page=> {
    await page.locator('#v2EnhancementRow [data-enhancement="crisp"]').click();
    await page.locator('#v2EnableCamera').click();
    await page.waitForFunction(()=>document.getElementById('v2HudState').textContent==='LIVE');
    await page.locator('#v2PhotoButton').click();
    await page.waitForSelector('#v2Review:not([hidden])');
    const initial=await page.locator('#v2ReviewNote').textContent();
    assert.match(initial,/Preview|nothing has been written yet/);
    // Applying the active preset must take the same rerender path as a tap.
    assert.match(initial,/Preview/,'first review re-renders active edits instead of showing the unedited capture');
    await page.waitForFunction(()=>document.getElementById('v2ReviewNote').textContent.startsWith('Held —'),null,{timeout:30000});
  });
});

test('failed enhancement texture allocation reports a render failure without throwing', options, async () => {
  const result=await browserTest(async page=>page.evaluate(async()=>{
    const {GlRenderer}=await import('/app/v2/render/gl-renderer.js');
    const source=document.createElement('canvas');source.width=64;source.height=64;
    const output=document.createElement('canvas'),renderer=new GlRenderer(output);
    renderer.uploadHeld(source);renderer.render('rgb',{width:64,height:64});
    const gl=output.getContext('webgl');gl.createTexture=()=>null;
    try { return {rendered:renderer.render('rgb',{width:64,height:64},undefined,{enhancement:{smoothing:1,sharpness:0,detail:0}}),reason:renderer.unavailableReason}; }
    catch(e) { return {threw:e.message}; }
  }));
  assert.equal(result.threw,undefined,JSON.stringify(result));
  assert.equal(result.rendered,false);assert.match(result.reason,/enhancement/i);
});

for(const [width,height] of [[568,320],[667,375],[932,430]]) test(`landscape camera uses both columns without covering capture controls at ${width}x${height}`,options,async()=>{
  await browserTest(async page=>{
    await page.setViewportSize({width,height});
    const layout=await page.evaluate(()=>{
      const shell=document.querySelector('.viewfinder-wrap').getBoundingClientRect();
      const dock=document.querySelector('.dock').getBoundingClientRect();
      return {columns:getComputedStyle(document.querySelector('.camera-layout')).gridTemplateColumns,shellBottom:shell.bottom,dockTop:dock.top,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.notEqual(layout.columns,'none');
    assert.ok(layout.shellBottom<=layout.dockTop,JSON.stringify(layout));
    assert.equal(layout.overflow,false);
  });
});
