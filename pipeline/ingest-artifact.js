// pipeline/ingest-artifact.js  (Phase 5 — artifact -> scene-JSON via render & sample)
//
// Loads an HTML artifact in headless Chromium, samples every visual element's box /
// effective opacity / text at rAF rate, and bakes the sampled motion into scene-JSON
// keyframes for the AE build engine. Two modes:
//
//   node pipeline/ingest-artifact.js examples/demo.html [--out scene.json] [--seconds 2.6]
//       -> "load" mode: sample from page load (CSS @keyframes autoplay) for
//          --seconds (default 2.6). The artifact must have a fixed-size #stage element.
//   node pipeline/ingest-artifact.js my-explainer.html --scenes
//       -> "scenes" mode: pause the player, click each scene chip, sample each
//          scene's entrance animation deterministically, one precomp per scene.
//          Expects a chip player: #chips .chip buttons, #play/#playlabel, and a
//          `dur: { s1: 4000, ... }` map (ms) in the page source.
//   --out  -> where to write the scene JSON (default: next to the artifact,
//            <name>.scene.json).
//   --hd  -> scale the comp to DELIVERY resolution: the stage's SHORT side maps to
//            1080 px (9:16 stage -> 1080x1920, 16:9 -> 1920x1080; long side snaps to
//            1920 within 1%). The artifact still renders at its native CSS layout —
//            sampling is unchanged — and all emitted geometry (positions, sizes,
//            fonts, paths, ramp points, raster scales) is multiplied into comp space.
//            Rasters are captured at DPR >= the scale factor so they stay crisp.
//
// SVG policy (logged per element in the report): a profile-matched chart path is
// rebuilt as an EDITABLE shape path + Trim Paths (draw-on baked from sampled
// stroke-dashoffset); all other inline SVGs are rasterized to PNG image layers
// (screenshots at DPR 2-4, layer scale compensated for comp resolution).

const fs = require('fs');
const path = require('path');
const { BridgeError, fail } = require('./errors');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { fail('ingest', e); }

const FPS = 30;
const SETTLE_S = 3.2;        // per-scene sampling window (entrances settle < ~2 s)
let DPR = 2;                 // raster screenshot density — raised under --hd (see preflight)
const HD = process.argv.includes('--hd');
const HD_SHORT_SIDE = 1080;  // delivery target: short side -> 1080, long side snaps to 1920

// ---------------------------------------------------------------- color utils
function parseColor(s) {
  if (!s) return null;
  const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}
function toHex(c) {
  const h = (x) => Math.round(x).toString(16).padStart(2, '0');
  return ('#' + h(c.r) + h(c.g) + h(c.b)).toUpperCase();
}
function firstGradientColor(bgImage) {
  const m = (bgImage || '').match(/rgba?\([^)]+\)/);
  return m ? parseColor(m[0]) : null;
}

// ------------------------------------------------------------- in-page script
// Installs a rAF sampler over every element under the stage. Runs in browser.
const PAGE_FNS = `
  window.__mcpEffOpacity = function (e, stop) {
    var o = 1, n = e;
    while (n && n !== stop.parentElement && n.nodeType === 1) {
      var co = parseFloat(getComputedStyle(n).opacity);
      if (!isNaN(co)) o *= co;
      n = n.parentElement;
    }
    return o;
  };
  window.__mcpTextLines = function (e) {
    // split soft-wrapped text into real lines (text + union box) by per-char caret rects
    var lines = [], cur = null, lastY = null;
    function push() { if (cur && /\\S/.test(cur.text)) lines.push(cur); cur = null; }
    var walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var txt = node.nodeValue;
      for (var i = 0; i < txt.length; i++) {
        var r = document.createRange();
        r.setStart(node, i); r.setEnd(node, i + 1);
        var rect = r.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) { if (cur) cur.text += txt[i]; continue; }
        if (lastY !== null && Math.abs(rect.y - lastY) > rect.height * 0.6) push();
        lastY = rect.y;
        if (!cur) cur = { text: '', x1: rect.x, y1: rect.y, x2: rect.right, y2: rect.bottom };
        cur.text += txt[i];
        cur.x1 = Math.min(cur.x1, rect.x); cur.y1 = Math.min(cur.y1, rect.y);
        cur.x2 = Math.max(cur.x2, rect.right); cur.y2 = Math.max(cur.y2, rect.bottom);
      }
    }
    push();
    for (var L = 0; L < lines.length; L++) {
      lines[L].text = lines[L].text.replace(/\\s+/g, ' ').replace(/^ | $/g, '');
    }
    return lines;
  };
  window.__mcpEnumerate = function (stageSel) {
    var stage = document.querySelector(stageSel);
    var all = stage.querySelectorAll('*');
    var els = [stage];
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.closest('svg') && e.closest('svg') !== e) continue; // svg internals ride with their root
      els.push(e);
    }
    for (var k = 0; k < els.length; k++) {
      var el = els[k];
      el.__mcpIdx = k;
      el.__mcpTrackText = false;
      for (var c = 0; c < el.childNodes.length; c++) {
        if (el.childNodes[c].nodeType === 3 && /\\S/.test(el.childNodes[c].nodeValue)) { el.__mcpTrackText = true; break; }
      }
    }
    window.__mcpEls = els;
    window.__mcpStage = stage;
    return els.length;
  };
  window.__mcpStartSampling = function () {
    var stage = window.__mcpStage;
    window.__mcpSamples = [];
    window.__mcpDone = false;
    var t0 = null;
    function tick(now) {
      if (t0 === null) t0 = now;
      var sr = stage.getBoundingClientRect();
      var fr = { t: (now - t0) / 1000, els: [] };
      for (var i = 0; i < window.__mcpEls.length; i++) {
        var e = window.__mcpEls[i];
        var r = e.getBoundingClientRect();
        var rec = {
          x: r.x - sr.x, y: r.y - sr.y, w: r.width, h: r.height,
          o: window.__mcpEffOpacity(e, stage)
        };
        if (e.__mcpTrackText) rec.tx = e.textContent;
        if (e.tagName.toLowerCase() === 'svg') {
          var p = e.querySelector('path');
          if (p) {
            var cs = getComputedStyle(p);
            rec.dash = cs.strokeDashoffset;
          }
        }
        fr.els.push(rec);
      }
      window.__mcpSamples.push(fr);
      if (!window.__mcpDone) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };
  window.__mcpCollect = function (stageSel) {
    window.__mcpDone = true;
    var stage = window.__mcpStage;
    var sr = stage.getBoundingClientRect();
    var meta = [];
    for (var i = 0; i < window.__mcpEls.length; i++) {
      var e = window.__mcpEls[i];
      var cs = getComputedStyle(e);
      var direct = '';
      for (var c = 0; c < e.childNodes.length; c++) {
        if (e.childNodes[c].nodeType === 3) direct += e.childNodes[c].nodeValue;
      }
      var r = e.getBoundingClientRect();
      var m = {
        i: i, tag: e.tagName.toLowerCase(), id: e.id || '',
        cls: (typeof e.className === 'string' ? e.className : (e.className.baseVal || '')),
        directText: direct.replace(/\\s+/g, ' ').replace(/^ | $/g, ''),
        pcls: (e.parentElement && typeof e.parentElement.className === 'string') ? e.parentElement.className : '',
        pi: (e.parentElement && e.parentElement.__mcpIdx !== undefined) ? e.parentElement.__mcpIdx : -1,
        x: r.x - sr.x, y: r.y - sr.y, w: r.width, h: r.height,
        bg: cs.backgroundColor, bgImage: cs.backgroundImage,
        color: cs.color, fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily, fontStyle: cs.fontStyle,
        letterSpacing: cs.letterSpacing, textAlign: cs.textAlign,
        lineHeight: parseFloat(cs.lineHeight),
        radius: parseFloat(cs.borderTopLeftRadius) || 0,
        radiusPct: /%$/.test(cs.borderTopLeftRadius),
        bw: [parseFloat(cs.borderTopWidth) || 0, parseFloat(cs.borderRightWidth) || 0,
             parseFloat(cs.borderBottomWidth) || 0, parseFloat(cs.borderLeftWidth) || 0],
        bc: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
        display: cs.display, zIndex: cs.zIndex
      };
      if (m.tag === 'svg') {
        m.viewBox = e.getAttribute('viewBox') || '';
        var p = e.querySelector('path');
        if (p) { m.pathD = p.getAttribute('d') || ''; var pcs = getComputedStyle(p);
                 m.pathStroke = pcs.stroke; m.pathStrokeW = parseFloat(pcs.strokeWidth) || 1;
                 m.pathFill = pcs.fill; m.dashArray = pcs.strokeDasharray; }
      }
      if (m.directText) {
        m.lines = window.__mcpTextLines(e);
        for (var li = 0; li < m.lines.length; li++) {
          var ln = m.lines[li];
          m.lines[li] = { text: ln.text, x: (ln.x1 + ln.x2) / 2 - sr.x, y: (ln.y1 + ln.y2) / 2 - sr.y };
        }
      }
      meta.push(m);
    }
    return { stage: { w: sr.width, h: sr.height }, meta: meta, samples: window.__mcpSamples };
  };
`;

// ----------------------------------------------------------- keyframe baking
// samples: [{t, v}] (v number or [x,y]) -> simplified keys at <=FPS density
function bakeSeries(points, eps) {
  if (!points.length) return [];
  // downsample to the FPS grid (nearest sample per frame)
  const grid = [];
  const tEnd = points[points.length - 1].t;
  let pi = 0;
  for (let f = 0; ; f++) {
    const t = f / FPS;
    if (t > tEnd + 1 / FPS) break;
    while (pi < points.length - 1 && Math.abs(points[pi + 1].t - t) <= Math.abs(points[pi].t - t)) pi++;
    grid.push({ t: +t.toFixed(4), v: points[pi].v });
  }
  // collinear / static simplification (keep a point if removing it errs > eps)
  const isVec = Array.isArray(grid[0].v);
  const err = (a, b, m) => {
    const k = (m.t - a.t) / Math.max(b.t - a.t, 1e-9);
    if (isVec) {
      let mx = 0;
      for (let d = 0; d < m.v.length; d++) mx = Math.max(mx, Math.abs(a.v[d] + (b.v[d] - a.v[d]) * k - m.v[d]));
      return mx;
    }
    return Math.abs(a.v + (b.v - a.v) * k - m.v);
  };
  const keep = new Array(grid.length).fill(false);
  keep[0] = keep[grid.length - 1] = true;
  (function simplify(lo, hi) {
    if (hi - lo < 2) return;
    let worst = -1, worstErr = 0;
    for (let i = lo + 1; i < hi; i++) {
      const e = err(grid[lo], grid[hi], grid[i]);
      if (e > worstErr) { worstErr = e; worst = i; }
    }
    if (worstErr > eps) { keep[worst] = true; simplify(lo, worst); simplify(worst, hi); }
  })(0, grid.length - 1);
  const keys = grid.filter((_, i) => keep[i]);
  // a flat series collapses to its endpoints -> if truly constant, single value
  if (keys.length === 2 && err(keys[0], keys[1], { t: (keys[0].t + keys[1].t) / 2, v: keys[0].v }) < 1e-9) {
    const flat = isVec
      ? keys[0].v.every((d, j) => Math.abs(d - keys[1].v[j]) < eps)
      : Math.abs(keys[0].v - keys[1].v) < eps;
    if (flat) return [keys[0]];
  }
  return keys;
}

function seriesFor(samples, idx, pick) {
  return samples.map((fr) => ({ t: fr.t, v: pick(fr.els[idx]) })).filter((p) => p.v !== undefined && p.v !== null);
}

// --------------------------------------------------------------- svg path -> AE
function parseSvgPath(d, viewBox, rectW, rectH) {
  const vb = viewBox.split(/[ ,]+/).map(Number); // [minx, miny, w, h]
  const sx = rectW / (vb[2] || rectW), sy = rectH / (vb[3] || rectH);
  const tokens = d.match(/[MC]|-?[\d.]+/g) || [];
  let i = 0;
  const verts = [], inT = [], outT = [];
  const X = (x) => (x - vb[0]) * sx - rectW / 2;  // layer-local, centered
  const Y = (y) => (y - vb[1]) * sy - rectH / 2;
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (tok === 'M') {
      const x = +tokens[i++], y = +tokens[i++];
      verts.push([X(x), Y(y)]); inT.push([0, 0]); outT.push([0, 0]);
    } else if (tok === 'C') {
      const c1x = +tokens[i++], c1y = +tokens[i++];
      const c2x = +tokens[i++], c2y = +tokens[i++];
      const px = +tokens[i++], py = +tokens[i++];
      const prev = verts[verts.length - 1];
      outT[outT.length - 1] = [X(c1x) - prev[0], Y(c1y) - prev[1]];
      verts.push([X(px), Y(py)]); inT.push([X(c2x) - X(px), Y(c2y) - Y(py)]); outT.push([0, 0]);
    }
  }
  return { vertices: verts, inTangents: inT, outTangents: outT, closed: false };
}

// ------------------------------------------------------------- classification
function classify(m, profile) {
  if (m.display === 'none' || m.w < 0.5 || m.h < 0.5) return 'skip';
  if (m.tag === 'svg') {
    if (profile.vectorPath && (m.cls.includes(profile.vectorPath) ||
        (m.pcls || '').includes(profile.vectorPath))) return 'vector';
    return 'raster';
  }
  const bg = parseColor(m.bg);
  const hasBg = (bg && bg.a > 0.04) || /gradient/.test(m.bgImage || '');
  const maxBw = Math.max(...m.bw);
  const hasBorder = maxBw > 0.1 && m.bc.some((c) => { const p = parseColor(c); return p && p.a > 0.04; });
  if (hasBg || hasBorder) return 'box';
  if (m.directText) return 'text';
  return 'skip';
}

// fallback PostScript name, used when the builder can't find the CSS family in AE
function fontFor(weight) {
  const w = parseInt(weight, 10) || 400;
  return w >= 550 ? 'Arial-BoldMT' : 'ArialMT';
}

// first concrete family in a computed font-family stack; generic keywords
// (sans-serif, system-ui, ...) have no AE equivalent and return null
const GENERIC_FAMILIES = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|-apple-system|BlinkMacSystemFont|emoji|math|fangsong)$/i;
function firstFamily(stack) {
  for (const raw of String(stack || '').split(',')) {
    const f = raw.trim().replace(/^["']|["']$/g, '');
    if (f && !GENERIC_FAMILIES.test(f)) return f;
  }
  return null;
}

// triangle via CSS border hack: zero content box, transparent side borders
function isCssTriangle(m) {
  return m.bw[2] > 2 && m.bw[3] > 2 && m.bw[1] > 2 &&
    parseColor(m.bc[3]) && parseColor(m.bc[3]).a < 0.05 &&
    parseColor(m.bc[1]) && parseColor(m.bc[1]).a < 0.05 &&
    parseColor(m.bc[2]) && parseColor(m.bc[2]).a > 0.5;
}

// ------------------------------------------------------------ layer emission
function emitLayers(collect, sceneName, opts) {
  const { meta, samples } = collect;
  const layers = [];
  const notes = [];
  const skipIdx = new Set(opts.skipIndices || []);

  const byIdx = new Map(meta.map((m) => [m.i, m]));
  // classification pre-pass (lets us fold inline text spans into their text parent)
  const kindOf = new Map();
  for (const m of meta) kindOf.set(m.i, m.i === 0 ? 'skip' : classify(m, opts.profile || {}));
  const hasTextAncestor = (m) => {
    for (let p = byIdx.get(m.pi); p; p = byIdx.get(p.pi)) {
      if (kindOf.get(p.i) === 'text') return true;
      if (p.pi < 0) break;
    }
    return false;
  };

  for (const m of meta) {
    if (m.i === 0) continue; // the stage itself
    if (skipIdx.has(m.i)) continue;
    if (opts.excludeCls && opts.excludeCls.some((c) => m.cls.includes(c))) continue;
    const kind = kindOf.get(m.i);
    if (kind === 'skip') continue;
    if (kind === 'text' && hasTextAncestor(m)) {
      notes.push(`${m.cls.split(' ')[0] || m.tag}_${m.i}: inline span folded into parent text layer (its own color flattened)`);
      continue;
    }

    const oSeries = seriesFor(samples, m.i, (e) => Math.round(e.o * 1000) / 10);
    const maxO = Math.max(...oSeries.map((p) => p.v));
    if (maxO < 0.5) continue; // never visible

    const cSeries = seriesFor(samples, m.i, (e) => [
      Math.round((e.x + e.w / 2) * 100) / 100, Math.round((e.y + e.h / 2) * 100) / 100,
    ]);
    const wSeries = seriesFor(samples, m.i, (e) => [e.w, e.h]);
    const finalW = m.w || wSeries[wSeries.length - 1].v[0];
    const finalH = m.h || wSeries[wSeries.length - 1].v[1];
    const sSeries = wSeries.map((p) => ({
      t: p.t,
      v: [Math.round(p.v[0] / Math.max(finalW, 0.01) * 1000) / 10,
          Math.round(p.v[1] / Math.max(finalH, 0.01) * 1000) / 10],
    }));

    const oKeys = bakeSeries(oSeries, 0.4);
    const pKeys = bakeSeries(cSeries, 0.4);
    const sKeys = bakeSeries(sSeries, 0.6);

    const nameBase = (m.id || m.cls.split(' ')[0] || m.tag) + '_' + m.i;
    const animations = [];
    const transform = {};

    if (oKeys.length > 1) animations.push({ property: 'opacity', keyframes: oKeys });
    else transform.opacity = oKeys.length ? oKeys[0].v : 100;
    if (pKeys.length > 1) animations.push({ property: 'position', keyframes: pKeys });
    else if (pKeys.length) transform.position = pKeys[0].v;

    const layer = { name: `${sceneName} ${nameBase}`, transform, zIndex: m.zIndex === 'auto' ? 0 : +m.zIndex, domIndex: m.i };

    const makeTextSpec = () => {
      const fill = parseColor(m.color) || { r: 0, g: 0, b: 0, a: 1 };
      const ls = parseFloat(m.letterSpacing);
      const just = ['left', 'right', 'center'].includes(m.textAlign) ? m.textAlign
        : (m.textAlign === 'start' ? 'left' : 'center');
      const spec = {
        value: (m.lines && m.lines.length ? m.lines.map((l) => l.text).join('\r') : m.directText),
        font: fontFor(m.fontWeight),
        size: Math.round(m.fontSize * 10) / 10,
        fill: toHex(fill),
        justification: just,
        tracking: isNaN(ls) ? 0 : Math.round(ls / m.fontSize * 1000),
      };
      // the artifact's real family + weight; the builder looks it up in AE and falls
      // back to `font` (with a warning) when it is not installed
      const fam = firstFamily(m.fontFamily);
      if (fam) {
        spec.fontFamily = fam;
        spec.fontWeight = parseInt(m.fontWeight, 10) || 400;
        if (m.fontStyle === 'italic' || m.fontStyle === 'oblique') spec.fontItalic = true;
      }
      return spec;
    };
    const bakeSourceText = () => {
      const tSeries = samples.map((fr) => ({ t: fr.t, v: fr.els[m.i].tx })).filter((p) => p.v !== undefined);
      if (!tSeries.length) return null;
      const tKeys = [];
      for (const p of tSeries) {
        const clean = p.v.replace(/\s+/g, ' ').trim();
        if (!tKeys.length || tKeys[tKeys.length - 1].v !== clean) tKeys.push({ t: +p.t.toFixed(4), v: clean });
      }
      return tKeys.length > 1 ? tKeys : null;
    };

    if (kind === 'text') {
      if (m.lines && m.lines.length > 1) {
        // wrapped text -> one layer per line at the EXACT sampled line position.
        // (AE 2026 scripting quirk: rendered baseline gap = doc.leading + a constant
        // ~31px regardless of font size, so multi-line point text can't be placed
        // reliably via leading — per-line layers are pixel-exact instead.)
        const elemCx = m.x + m.w / 2, elemCy = m.y + m.h / 2;
        m.lines.forEach((ln, li) => {
          const off = [ln.x - elemCx, ln.y - elemCy];
          const ll = {
            name: `${sceneName} ${nameBase}_L${li + 1}`,
            type: 'text',
            text: { ...makeTextSpec(), value: ln.text },
            transform: { anchor: 'center' },
            zIndex: layer.zIndex, domIndex: m.i + li * 0.01,
            animations: [],
          };
          if (oKeys.length > 1) ll.animations.push({ property: 'opacity', keyframes: oKeys });
          else ll.transform.opacity = oKeys.length ? oKeys[0].v : 100;
          if (pKeys.length > 1) {
            ll.animations.push({
              property: 'position',
              keyframes: pKeys.map((k) => ({ ...k, v: [Math.round((k.v[0] + off[0]) * 100) / 100, Math.round((k.v[1] + off[1]) * 100) / 100] })),
            });
          } else {
            ll.transform.position = [Math.round(ln.x * 100) / 100, Math.round(ln.y * 100) / 100];
          }
          if (!ll.animations.length) delete ll.animations;
          layers.push(ll);
        });
        notes.push(`${sceneName} ${nameBase}: soft-wrapped text split into ${m.lines.length} per-line layers (exact sampled line boxes)`);
        continue;
      }
      layer.type = 'text';
      layer.text = makeTextSpec();
      transform.anchor = 'center';
      // single line in a wider box (left/right-aligned, RTL): place the layer at the
      // rendered line's center, not the box center
      if (m.lines && m.lines.length === 1) {
        const off = [m.lines[0].x - (m.x + m.w / 2), m.lines[0].y - (m.y + m.h / 2)];
        if (Math.abs(off[0]) > 0.5 || Math.abs(off[1]) > 0.5) {
          const shift = (v) => [Math.round((v[0] + off[0]) * 100) / 100, Math.round((v[1] + off[1]) * 100) / 100];
          const pa = animations.find((a) => a.property === 'position');
          if (pa) pa.keyframes = pa.keyframes.map((k) => ({ ...k, v: shift(k.v) }));
          else if (transform.position) transform.position = shift(transform.position);
        }
      }
      if (sKeys.length > 1) animations.push({ property: 'scale', keyframes: sKeys });
      const tKeys = bakeSourceText();
      if (tKeys) {
        animations.push({ property: 'sourceText', keyframes: tKeys });
        notes.push(`${layer.name}: count-up baked as ${tKeys.length} sourceText hold keys`);
      }
    } else if (kind === 'box') {
      layer.type = 'shape';
      if (isCssTriangle(m)) {
        const w = m.w, h = m.h;
        layer.shape = {
          kind: 'path',
          path: { vertices: [[-w / 2, h / 2], [0, -h / 2], [w / 2, h / 2]], closed: true },
          fill: toHex(parseColor(m.bc[2])),
        };
        notes.push(`${layer.name}: CSS border-triangle rebuilt as path`);
      } else {
        const bg = parseColor(m.bg);
        const grad = firstGradientColor(m.bgImage);
        const fillC = (bg && bg.a > 0.04) ? bg : grad;
        // CSS clamps a radius to half the short side (border-radius: 999px pills)
        const radiusPx = Math.min(m.radiusPct ? m.radius / 100 * Math.min(finalW, finalH) : m.radius, Math.min(finalW, finalH) / 2);
        // a true ellipse needs ~equal sides; an oblong with radius >= short-side/2 is a
        // CSS pill -> rounded rect (CSS clamps the radius, it never turns into an ellipse)
        const isEllipse = radiusPx >= Math.min(finalW, finalH) / 2 - 0.5 && Math.abs(finalW - finalH) < 1.5;
        layer.shape = { kind: isEllipse ? 'ellipse' : 'rect', size: [Math.round(finalW * 10) / 10, Math.round(finalH * 10) / 10] };
        if (fillC) layer.shape.fill = toHex(fillC);
        if (fillC && fillC.a < 0.95) {
          const opAnim = animations.find((a) => a.property === 'opacity');
          if (opAnim) {
            // fading element: fold the fill alpha into every opacity key
            opAnim.keyframes = opAnim.keyframes.map((k) => ({ ...k, v: Math.round(k.v * fillC.a * 10) / 10 }));
            notes.push(`${layer.name}: translucent background (alpha ${fillC.a}) folded into its opacity keyframes`);
          } else {
            transform.opacity = Math.round((transform.opacity !== undefined ? transform.opacity : 100) * fillC.a);
            notes.push(`${layer.name}: translucent background mapped to ${transform.opacity}% layer opacity`);
          }
        }
        if (grad && bg && bg.a <= 0.04) notes.push(`${layer.name}: gradient approximated by first stop ${toHex(grad)}`);
        if (!isEllipse && radiusPx > 0.5) layer.shape.roundness = Math.round(radiusPx * 10) / 10;
        const maxBw = Math.max(...m.bw);
        if (maxBw > 0.1) {
          const bIdx = m.bw.indexOf(maxBw);
          const bcol = parseColor(m.bc[bIdx]);
          if (bcol && bcol.a > 0.04) { layer.shape.stroke = toHex(bcol); layer.shape.strokeWidth = Math.round(maxBw * 10) / 10; }
        }
      }
      if (sKeys.length > 1) animations.push({ property: 'scale', keyframes: sKeys });
    } else if (kind === 'vector') {
      // editable path + trim from sampled dashoffset
      const p = parseSvgPath(m.pathD, m.viewBox, finalW, finalH);
      layer.type = 'shape';
      layer.shape = {
        kind: 'path', path: p,
        stroke: toHex(parseColor(m.pathStroke) || { r: 0, g: 0, b: 0 }),
        strokeWidth: Math.round(m.pathStrokeW * (finalH / (+m.viewBox.split(/[ ,]+/)[3] || finalH)) * 10) / 10,
        trim: { end: 0 },
      };
      const dashTotal = parseFloat(m.dashArray) || 0;
      if (dashTotal > 0) {
        const dSeries = samples
          .map((fr) => ({ t: fr.t, v: fr.els[m.i].dash !== undefined ? Math.round((1 - parseFloat(fr.els[m.i].dash) / dashTotal) * 1000) / 10 : undefined }))
          .filter((pt) => pt.v !== undefined);
        const dKeys = bakeSeries(dSeries, 0.4);
        if (dKeys.length > 1) {
          animations.push({
            property: ['ADBE Root Vectors Group', 'ADBE Vector Group', 'ADBE Vectors Group', 'ADBE Vector Filter - Trim', 'ADBE Vector Trim End'],
            keyframes: dKeys,
          });
        } else { layer.shape.trim.end = dKeys.length ? dKeys[0].v : 100; }
        notes.push(`${layer.name}: SVG path rebuilt as shape path; draw-on baked into Trim Paths from stroke-dashoffset`);
      } else { layer.shape.trim.end = 100; }
      if (sKeys.length > 1) animations.push({ property: 'scale', keyframes: sKeys });
    } else if (kind === 'raster') {
      layer.type = 'image';
      layer.image = { path: m.assetPath }; // filled by caller after screenshots
      transform.scale = [100 / DPR, 100 / DPR];
      if (sKeys.length > 1) {
        animations.push({ property: 'scale', keyframes: sKeys.map((k) => ({ ...k, v: [k.v[0] / DPR, k.v[1] / DPR] })) });
        delete transform.scale;
      }
      layer.rasterIdx = m.i;
      notes.push(`${layer.name}: inline SVG rasterized to PNG image layer (visually faithful, not vector-editable)`);
    }

    if (animations.length) layer.animations = animations;
    layers.push(layer);

    // a box that carries its own text (e.g. the "9 : 16" badge pill) gets a label on top
    if (kind === 'box' && m.directText) {
      const tl = {
        name: `${sceneName} ${nameBase}_label`,
        type: 'text',
        text: makeTextSpec(),
        transform: { ...transform, anchor: 'center', opacity: 100 },
        zIndex: layer.zIndex,
        domIndex: m.i + 0.25,
        animations: [],
      };
      if (oKeys.length > 1) tl.animations.push({ property: 'opacity', keyframes: oKeys });
      if (pKeys.length > 1) { delete tl.transform.position; tl.animations.push({ property: 'position', keyframes: pKeys }); }
      if (!tl.animations.length) delete tl.animations;
      layers.push(tl);
    }
  }

  // stacking: DOM paint order (zIndex, then document order); scene-JSON layers[0] = top
  layers.sort((a, b) => (a.zIndex - b.zIndex) || (a.domIndex - b.domIndex));
  layers.reverse();
  for (const l of layers) { delete l.zIndex; delete l.domIndex; }
  return { layers, notes };
}

// --------------------------------------------------------------------- main
const USAGE = 'usage: node pipeline/ingest-artifact.js <artifact.html> [--scenes] [--hd] [--out scene.json] [--seconds N]';

// positional artifact path + flags (flags may come in any order)
function parseArgs(argv) {
  const o = { html: null, out: null, seconds: 2.6 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--seconds') o.seconds = parseFloat(argv[++i]);
    else if (a.startsWith('--')) continue; // --scenes / --hd read via process.argv
    else if (!o.html) o.html = a;
  }
  return o;
}

// bundled Chromium first; fall back to an installed Google Chrome so a fresh
// checkout works without the ~150 MB browser download
async function launchBrowser() {
  try { return await chromium.launch(); }
  catch (e) {
    if (!/Executable doesn't exist/.test(e.message)) throw e;
    try {
      const b = await chromium.launch({ channel: 'chrome' });
      console.log('note: Playwright Chromium not installed — using your Google Chrome instead');
      return b;
    } catch (e2) { throw e; }
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const htmlPath = args.html;
  if (!htmlPath) throw new BridgeError('No artifact given.', { tryThis: USAGE });
  if (!(args.seconds > 0)) throw new BridgeError('--seconds needs a positive number.', { tryThis: USAGE });
  const scenesMode = process.argv.includes('--scenes');
  const absHtml = path.resolve(htmlPath);
  if (!fs.existsSync(absHtml)) throw new BridgeError('The artifact file does not exist.', { file: absHtml, tryThis: 'check the path; quote it if it contains spaces.' });
  if (!/\.html?$/i.test(absHtml)) throw new BridgeError('The artifact must be an .html file.', { file: absHtml, tryThis: 'save the Claude artifact as a self-contained .html file and pass that.' });
  const base = path.basename(htmlPath).replace(/\.html?$/i, '');
  const outScene = args.out ? path.resolve(args.out) : path.join(path.dirname(absHtml), base + '.scene.json');
  const assetsDir = path.join(__dirname, 'out', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(path.dirname(outScene), { recursive: true });

  const html = fs.readFileSync(absHtml, 'utf8');
  const allNotes = [];
  const stageSel = '#stage';
  const noStage = () => new BridgeError('The artifact has no element with id="stage".', {
    file: absHtml,
    tryThis: 'wrap the visible design in a fixed-size <div id="stage" style="width:1280px;height:720px;position:relative"> (see examples/demo.html).',
  });

  const browser = await launchBrowser();

  // --hd preflight: measure the stage's CSS box once, derive the comp-space scale and
  // the raster DPR BEFORE the sampling context is created (rects are CSS px at any DPR,
  // so sampling itself is unaffected — only screenshots need the density).
  let fx = 1, fy = 1, targetW = null, targetH = null;
  if (HD) {
    const probe = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1 });
    await probe.goto('file://' + absHtml);
    await probe.waitForTimeout(400);
    if (!(await probe.$(stageSel))) throw noStage();
    const box = await probe.$eval(stageSel, (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    await probe.close();
    const f = HD_SHORT_SIDE / Math.min(box.w, box.h);
    const longPx = Math.max(box.w, box.h) * f;
    const snap = Math.abs(longPx - 1920) / 1920 <= 0.01; // 9:16-ish / 16:9-ish stages → exact 1080x1920 / 1920x1080
    if (box.w <= box.h) {
      targetW = HD_SHORT_SIDE; targetH = snap ? 1920 : Math.round(longPx);
    } else {
      targetH = HD_SHORT_SIDE; targetW = snap ? 1920 : Math.round(longPx);
    }
    fx = targetW / box.w;
    fy = targetH / box.h;
    DPR = Math.max(2, Math.min(4, Math.ceil(Math.max(fx, fy)))); // rasters never upscale in comp space
    console.log(`hd: stage ${Math.round(box.w)}x${Math.round(box.h)} -> comp ${targetW}x${targetH} (x${fx.toFixed(3)}, raster DPR ${DPR})`);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: DPR });
  await page.goto('file://' + absHtml);
  if (!(await page.$(stageSel))) throw noStage();
  await page.addScriptTag({ content: PAGE_FNS });

  // Comp name from the artifact filename: "diversification-explainer" -> "Diversification_Explainer_Replica".
  const compName =
    base
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join('_') + '_Replica';

  let sceneDefs = []; // {name, start, duration, layers}
  let stage;

  if (!scenesMode) {
    // -------- load mode: enumerate ASAP and sample the autoplaying CSS animations
    await page.reload();
    await page.addScriptTag({ content: PAGE_FNS });
    await page.evaluate((sel) => { window.__mcpEnumerate(sel); window.__mcpStartSampling(); }, stageSel);
    await page.waitForTimeout(args.seconds * 1000);
    const collect = await page.evaluate((sel) => window.__mcpCollect(sel), stageSel);
    stage = collect.stage;
    const stageBg = parseColor(collect.meta[0].bg);
    if (stageBg && stageBg.a > 0.5) stage.bg = toHex(stageBg);
    const { layers, notes } = emitLayers(collect, 'main', { profile: {} });
    allNotes.push(...notes);
    await shootRasters(page, collect, layers, assetsDir, 'main');
    sceneDefs.push({ name: compName + '_Main', start: 0, duration: Math.ceil(collect.samples.at(-1).t) + 1, layers });
  } else {
    // -------- scenes mode: parse scene durations from the source, step via chips
    const durM = html.match(/dur:\s*\{([^}]*)\}/);
    const playerOk = await page.$('#chips .chip') && await page.$('#playlabel') && await page.$('#play');
    if (!durM || !playerOk) {
      throw new BridgeError('--scenes needs a chip-based scene player, and this artifact does not have one.', {
        file: absHtml,
        tryThis: 'drop --scenes to sample it from page load, or add #chips .chip buttons, #play/#playlabel and a `dur: { s1: 4000, ... }` map.',
      });
    }
    const durations = [...durM[1].matchAll(/s(\d+):(\d+)/g)]
      .sort((a, b) => +a[1] - +b[1])
      .map((m) => +m[2] / 1000);
    console.log('scene durations (s):', durations.join(', '));

    await page.waitForTimeout(700); // let autoplay start
    // pause the player so scene timing is fully under our control
    const label = await page.$eval('#playlabel', (e) => e.textContent);
    if (label === 'Pause') await page.click('#play');
    await page.waitForTimeout(150);

    let start = 0;
    for (let i = 0; i < durations.length; i++) {
      const sceneName = 's' + (i + 1);
      await page.evaluate(({ sel, idx }) => {
        document.querySelectorAll('#chips .chip')[idx].click();
        window.__mcpEnumerate(sel);
        window.__mcpStartSampling();
      }, { sel: stageSel, idx: i });
      await page.waitForTimeout(Math.min(durations[i], SETTLE_S) * 1000 + 150);
      const collect = await page.evaluate((sel) => window.__mcpCollect(sel), stageSel);
      stage = collect.stage;

      const { layers, notes } = emitLayers(collect, sceneName, {
        profile: { vectorPath: 'chartbg' },
        excludeCls: ['badge9x16'],   // persistent badge handled once via the Overlay scene
      });
      allNotes.push(...notes);
      await shootRasters(page, collect, layers, assetsDir, sceneName);

      // the chartbg svg wrapper div: vector profile matches the svg INSIDE .chartbg —
      // mark via parent in emitLayers; svg cls is '' there. Handle: if a raster layer's
      // meta sits inside .chartbg, it was already vectorized; nothing else needed here.
      sceneDefs.push({ name: `${compName}_${sceneName}`, start, duration: durations[i], layers });
      start += durations[i];
      console.log(`scene ${sceneName}: ${layers.length} layers, ${collect.samples.length} raw samples`);
    }

    // overlay: persistent 9:16 badge from a fresh scene-1 mount
    await page.evaluate(({ sel }) => {
      document.querySelectorAll('#chips .chip')[0].click();
      window.__mcpEnumerate(sel);
      window.__mcpStartSampling();
    }, { sel: stageSel });
    await page.waitForTimeout(800);
    const oc = await page.evaluate((sel) => window.__mcpCollect(sel), stageSel);
    const badgeMeta = oc.meta.filter((m) => m.cls.includes('badge9x16'));
    if (badgeMeta.length) {
      const collectBadge = { stage: oc.stage, meta: badgeMeta, samples: oc.samples };
      const { layers } = emitLayers(collectBadge, 'overlay', { profile: {} });
      // static overlay: strip baked entrance, keep final state
      for (const l of layers) { delete l.animations; l.transform.opacity = 100; }
      sceneDefs.push({ name: compName + '_Overlay', start: 0, duration: start, layers });
    }

    // background gradient as a bottom precomp with a Gradient Ramp solid
    sceneDefs.unshift({
      name: compName + '_Background', start: 0, duration: start,
      layers: [{
        type: 'solid', name: 'bg gradient', solid: { color: '#FFFFFF' },
        effects: [{
          matchName: 'ADBE Ramp',
          params: {
            'ADBE Ramp-0001': [stage.w / 2, 0],
            'ADBE Ramp-0002': [1, 1, 1],
            'ADBE Ramp-0003': [stage.w / 2, stage.h],
            'ADBE Ramp-0004': [0xf4 / 255, 0xf8 / 255, 0xfd / 255],
          },
        }],
      }],
    });
    allNotes.push('stage gradient background rebuilt as solid + Gradient Ramp (top #FFFFFF -> bottom #F4F8FD)');
    allNotes.push('stage 22px rounded corners + card box-shadows omitted (AE comp edges are square; shadows not replicated)');
  }

  const totalDur = Math.max(...sceneDefs.map((s) => s.start + s.duration));
  const scene = {
    comp: {
      name: compName,
      width: Math.round(stage.w),
      height: Math.round(stage.h),
      fps: FPS,
      duration: totalDur,
      bg: scenesMode ? '#FFFFFF' : (stage.bg || '#000000'),
    },
    scenes: sceneDefs,
  };

  if (HD) {
    scaleScene(scene, fx, fy, targetW, targetH);
    allNotes.push(`hd: comp scaled to ${targetW}x${targetH} (x${fx.toFixed(3)}/${fy.toFixed(3)}); rasters captured at DPR ${DPR}`);
  }

  fs.writeFileSync(outScene, JSON.stringify(scene, null, 2));
  fs.writeFileSync(path.join(__dirname, 'out', base + '.ingest-notes.json'), JSON.stringify(allNotes, null, 2));
  console.log(`wrote ${outScene} (${sceneDefs.length} scenes, comp ${scene.comp.width}x${scene.comp.height}, ${totalDur}s)`);
  console.log('notes:', allNotes.length);
  await browser.close();
})().catch((e) => fail('ingest', e));

/**
 * --hd: multiply every piece of emitted geometry from stage-CSS space into comp space.
 * Sampling/baking happen at the artifact's native layout size (the page can't render
 * bigger — its CSS fixes the stage width); this is a pure linear map applied once at
 * the end. Percent-relative values (shape/text scale keys, trim %, opacity, tracking)
 * are scale-invariant and intentionally untouched; IMAGE layer scales are in raster-px
 * space and DO scale (their PNGs were captured at DPR >= factor, so no upscaling).
 */
function scaleScene(scene, fx, fy, targetW, targetH) {
  const favg = (fx + fy) / 2;
  const sx = (v) => Math.round(v * fx * 100) / 100;
  const sy = (v) => Math.round(v * fy * 100) / 100;
  const sPt = (p) => [sx(p[0]), sy(p[1])];
  scene.comp.width = targetW;
  scene.comp.height = targetH;
  for (const sc of scene.scenes) {
    for (const l of sc.layers) {
      const t = l.transform || {};
      if (Array.isArray(t.position)) t.position = sPt(t.position);
      if (Array.isArray(t.anchor)) t.anchor = sPt(t.anchor);
      if (l.type === 'image' && Array.isArray(t.scale)) t.scale = [sx(t.scale[0]), sy(t.scale[1])];
      if (l.text) {
        l.text.size = Math.round(l.text.size * fy * 10) / 10;
        if (l.text.strokeWidth) l.text.strokeWidth = Math.round(l.text.strokeWidth * favg * 10) / 10;
      }
      if (l.shape) {
        if (Array.isArray(l.shape.size)) l.shape.size = [sx(l.shape.size[0]), sy(l.shape.size[1])];
        if (l.shape.roundness) l.shape.roundness = Math.round(l.shape.roundness * favg * 10) / 10;
        if (l.shape.strokeWidth) l.shape.strokeWidth = Math.round(l.shape.strokeWidth * favg * 10) / 10;
        if (l.shape.path) {
          for (const k of ['vertices', 'inTangents', 'outTangents']) {
            if (Array.isArray(l.shape.path[k])) l.shape.path[k] = l.shape.path[k].map(sPt);
          }
        }
      }
      for (const ef of l.effects || []) {
        if (ef.matchName === 'ADBE Ramp' && ef.params) {
          // Ramp start/end are POINTS in comp space (0001/0003); colors stay.
          if (Array.isArray(ef.params['ADBE Ramp-0001'])) ef.params['ADBE Ramp-0001'] = sPt(ef.params['ADBE Ramp-0001']);
          if (Array.isArray(ef.params['ADBE Ramp-0003'])) ef.params['ADBE Ramp-0003'] = sPt(ef.params['ADBE Ramp-0003']);
        }
      }
      for (const an of l.animations || []) {
        if (an.property === 'position' || an.property === 'anchor') {
          for (const k of an.keyframes || []) k.v = sPt(k.v);
        } else if (an.property === 'scale' && l.type === 'image') {
          for (const k of an.keyframes || []) k.v = [sx(k.v[0]), sy(k.v[1])];
        }
      }
    }
  }
}

// screenshot raster layers' source elements (at settle state)
async function shootRasters(page, collect, layers, assetsDir, sceneName) {
  for (const l of layers) {
    if (l.type !== 'image' || l.rasterIdx === undefined) continue;
    const file = path.join(assetsDir, `${sceneName}-el${l.rasterIdx}.png`);
    const handle = await page.evaluateHandle((i) => window.__mcpEls[i], l.rasterIdx);
    try {
      await handle.asElement().screenshot({ path: file, omitBackground: true });
      l.image.path = file;
    } catch (e) {
      l.image.path = file + '.missing';
    }
    delete l.rasterIdx;
  }
}
