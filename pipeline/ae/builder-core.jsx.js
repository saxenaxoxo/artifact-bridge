// pipeline/ae/builder-core.jsx.js  (Phase 3 — shared build engine)
//
// Single source of truth: returns ES3 ExtendScript that compiles a scene object into
// a native AE master comp (precomps nested, layers, transforms, eased keyframes,
// expressions, effects, masks, shape paths, sourceText keys). The live path
// (build-scene.js) wraps it for `eval`; the portable path (export-jsx.js) embeds it
// in a standalone .jsx (with its own minimal JSON polyfill). Same core for both.
//
// Emitted code is strict ES3 (plan §3.4). Whole build runs in one undo group.
//
// EASE SEMANTICS (segment-based, backward-looking): `ease` declared on keyframe k
// shapes the segment ARRIVING at k (from k-1 to k) — matching CSS-transition intent:
//   easeOut    -> decelerate into k   (k.in influence high, k-1.out low)
//   easeIn     -> accelerate out of k-1 (k-1.out high, k.in low)
//   easeInOut  -> both ends ~66
//   [x1,y1,x2,y2] -> k-1.out influence = x1*100, k.in influence = (1-x2)*100
// An ease on the FIRST keyframe has no preceding segment and is ignored.
// `hold:true` on key k freezes the value FROM k until the next key.

'use strict';

const BUILDER_CORE = `
// ===== MCP build engine (ES3) =====
function mcpHexToRgb(hex) {
  var h = String(hex).replace("#", "");
  if (h.length === 3) { h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2); }
  var r = parseInt(h.substring(0, 2), 16) / 255;
  var g = parseInt(h.substring(2, 4), 16) / 255;
  var b = parseInt(h.substring(4, 6), 16) / 255;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return [0, 0, 0];
  return [r, g, b];
}
function mcpErrStr(e) {
  // AE error objects can themselves throw when concatenated ("Object of type Error
  // found where a Number ... is needed") — extract the message defensively.
  try { return String(e.message); } catch (e2) {}
  try { return String(e); } catch (e3) {}
  return "unprintable AE error";
}
function mcpWarn(result, msg) { if (result && result.warnings) result.warnings.push(msg); }
function mcpUniqueName(base) {
  function exists(n) { for (var i = 1; i <= app.project.numItems; i++) { try { if (app.project.item(i).name === n) return true; } catch (e) {} } return false; }
  if (!exists(base)) return base;
  var k = 2; while (exists(base + "_" + k)) k++; return base + "_" + k;
}
function mcpBlend(name) {
  var n = String(name).toLowerCase(); var M = BlendingMode;
  if (n === "add") return M.ADD;
  if (n === "screen") return M.SCREEN;
  if (n === "multiply") return M.MULTIPLY;
  if (n === "overlay") return M.OVERLAY;
  if (n === "lighten") return M.LIGHTEN;
  if (n === "darken") return M.DARKEN;
  if (n === "softlight" || n === "soft light") return M.SOFT_LIGHT;
  return M.NORMAL;
}
function mcpClampInfl(v) { return Math.max(0.1, Math.min(100, v)); }
function mcpResolveSegEase(ease) {
  // segment ease: fromOut shapes the out-side of the segment's start key,
  // toIn shapes the in-side of the segment's end key (the key the ease sits on).
  if (ease instanceof Array && ease.length >= 4) {
    return { bezier: true, fromOut: mcpClampInfl(ease[0] * 100), toIn: mcpClampInfl((1 - ease[2]) * 100) };
  }
  var n = String(ease || "linear");
  if (n === "easeIn")    return { bezier: true, fromOut: 75, toIn: 16.667 };
  if (n === "easeOut")   return { bezier: true, fromOut: 16.667, toIn: 75 };
  if (n === "easeInOut") return { bezier: true, fromOut: 66, toIn: 66 };
  return { bezier: false, fromOut: 16.667, toIn: 16.667 };
}
function mcpEaseDims(prop) {
  // Temporal-ease dimensionality: TwoD (non-spatial) -> 2, ThreeD (non-spatial) -> 3,
  // EVERYTHING else (incl. TwoD_SPATIAL/ThreeD_SPATIAL position/anchor, OneD, color) -> 1.
  // Verified live on AE 26.0: position is ThreeD_SPATIAL and requires exactly 1 element.
  try {
    var t = prop.propertyValueType;
    if (t == PropertyValueType.TwoD) return 2;
    if (t == PropertyValueType.ThreeD) return 3;
  } catch (e) {}
  return 1;
}
function mcpEaseArrFill(dims, influence) {
  var a = [];
  for (var d = 0; d < dims; d++) a.push(new KeyframeEase(0, influence));
  return a;
}
function mcpKeyIndexFor(prop, t) {
  // robust against unsorted/duplicate input keys: resolve the real key index by time
  try { return prop.nearestKeyIndex(t); } catch (e) {}
  return -1;
}
function mcpSetSegmentEase(prop, kiFrom, kiTo, ease, result) {
  var spec = mcpResolveSegEase(ease);
  if (!spec.bezier) return; // linear is AE's default after setValueAtTime
  var dims = mcpEaseDims(prop);
  try {
    if (kiFrom > 0) {
      prop.setInterpolationTypeAtKey(kiFrom, prop.keyInInterpolationType(kiFrom), KeyframeInterpolationType.BEZIER);
      prop.setTemporalEaseAtKey(kiFrom, prop.keyInTemporalEase(kiFrom), mcpEaseArrFill(dims, spec.fromOut));
    }
    if (kiTo > 0) {
      prop.setInterpolationTypeAtKey(kiTo, KeyframeInterpolationType.BEZIER, prop.keyOutInterpolationType(kiTo));
      prop.setTemporalEaseAtKey(kiTo, mcpEaseArrFill(dims, spec.toIn), prop.keyOutTemporalEase(kiTo));
    }
  } catch (e) { mcpWarn(result, "ease fail @" + kiFrom + "->" + kiTo + ": " + mcpErrStr(e)); }
}
function mcpApplyAnim(prop, anim, result) {
  if (!prop) return;
  if (anim.expression !== undefined && anim.expression !== null) {
    try { prop.expression = anim.expression; prop.expressionEnabled = true; } catch (e) { mcpWarn(result, "expr fail: " + mcpErrStr(e)); }
  }
  var keys = anim.keyframes;
  if (!keys || !keys.length) return;
  var isTextDoc = false;
  try { isTextDoc = (prop.propertyValueType == PropertyValueType.TEXT_DOCUMENT); } catch (e) {}
  // pass 1: values
  for (var i = 0; i < keys.length; i++) {
    try {
      if (isTextDoc) { var d = prop.value; d.text = String(keys[i].v); prop.setValueAtTime(keys[i].t, d); }
      else prop.setValueAtTime(keys[i].t, keys[i].v);
    } catch (e) { mcpWarn(result, "setValueAtTime fail " + anim.property + ": " + mcpErrStr(e)); }
  }
  if (isTextDoc) {
    // text can't interpolate — force hold on every key
    for (var h = 0; h < keys.length; h++) {
      var hk = mcpKeyIndexFor(prop, keys[h].t);
      if (hk > 0) { try { prop.setInterpolationTypeAtKey(hk, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); } catch (e) {} }
    }
    return;
  }
  // pass 2: segment eases (backward-looking; see header)
  for (var j = 1; j < keys.length; j++) {
    if (keys[j].hold || keys[j].ease === undefined) continue;
    mcpSetSegmentEase(prop, mcpKeyIndexFor(prop, keys[j - 1].t), mcpKeyIndexFor(prop, keys[j].t), keys[j].ease, result);
  }
  // pass 3: holds (after eases so a hold's out-side always wins)
  for (var m = 0; m < keys.length; m++) {
    if (!keys[m].hold) continue;
    var mk = mcpKeyIndexFor(prop, keys[m].t);
    if (mk > 0) {
      try { prop.setInterpolationTypeAtKey(mk, prop.keyInInterpolationType(mk), KeyframeInterpolationType.HOLD); } catch (e) {}
    }
  }
}
function mcpTransformGroup(layer) { return layer.property("ADBE Transform Group"); }
function mcpResolveTransformProp(layer, token) {
  var tg = mcpTransformGroup(layer);
  switch (String(token).toLowerCase()) {
    case "opacity":  return tg.property("ADBE Opacity");
    case "position": return tg.property("ADBE Position");
    case "scale":    return tg.property("ADBE Scale");
    case "rotation": return tg.property("ADBE Rotate Z");
    case "anchor":   return tg.property("ADBE Anchor Point");
    case "sourcetext": try { return layer.property("ADBE Text Properties").property("ADBE Text Document"); } catch (e) { return null; }
  }
  return null;
}
function mcpResolveEffectParam(fx, key) {
  try { var p = fx.property(key); if (p) return p; } catch (e) {}
  var n = parseInt(key, 10);
  if (!isNaN(n)) { try { return fx.property(n); } catch (e) {} }
  return null;
}
function mcpResolveAnimProp(layer, property) {
  if (property instanceof Array) {
    var p = layer;
    for (var i = 0; i < property.length; i++) { try { p = p.property(property[i]); } catch (e) { return null; } }
    return p;
  }
  var s = String(property);
  if (s.substring(0, 7) === "effect:") {
    var parts = s.split(":");
    try { var fx = layer.property("ADBE Effect Parade").property(parts[1]); return mcpResolveEffectParam(fx, parts[2]); } catch (e) { return null; }
  }
  return mcpResolveTransformProp(layer, s);
}
function mcpApplyExpressions(layer, exprMap, result) {
  if (!exprMap) return;
  for (var token in exprMap) {
    if (!exprMap.hasOwnProperty(token)) continue;
    var p = mcpResolveAnimProp(layer, token); // supports tokens, effect:…, path arrays via JSON keys
    if (p) { try { p.expression = exprMap[token]; p.expressionEnabled = true; } catch (e) { mcpWarn(result, "expr " + token + ": " + mcpErrStr(e)); } }
    else { mcpWarn(result, "expr unresolved token: " + token); }
  }
}
function mcpAddEffects(layer, effects, result) {
  if (!effects) return;
  var parade = layer.property("ADBE Effect Parade");
  for (var i = 0; i < effects.length; i++) {
    var ef = effects[i]; var fx = null;
    try { fx = parade.addProperty(ef.matchName); } catch (e) { mcpWarn(result, "effect add fail " + ef.matchName + ": " + mcpErrStr(e)); continue; }
    if (ef.name) { try { fx.name = ef.name; } catch (e) {} }
    if (ef.params) {
      for (var key in ef.params) {
        if (!ef.params.hasOwnProperty(key)) continue;
        var p = mcpResolveEffectParam(fx, key);
        if (p) { try { p.setValue(ef.params[key]); } catch (e) { mcpWarn(result, "param " + key + ": " + mcpErrStr(e)); } }
        else { mcpWarn(result, "param unresolved " + ef.matchName + "." + key); }
      }
    }
    if (ef.animations) {
      for (var a = 0; a < ef.animations.length; a++) {
        var an = ef.animations[a];
        var pp = mcpResolveEffectParam(fx, an.property);
        if (pp) mcpApplyAnim(pp, an, result);
        else mcpWarn(result, "anim param unresolved " + ef.matchName + "." + an.property);
      }
    }
  }
}
// CSS family + weight -> installed PostScript name via app.fonts (AE 24.0+).
// Returns null when the family isn't installed or the API is unavailable.
var MCP_WEIGHT_STYLES = {
  100: ["Thin", "Hairline"], 200: ["ExtraLight", "Extra Light", "UltraLight"], 300: ["Light"],
  400: ["Regular", "Roman", "Book", "Normal"], 500: ["Medium"], 600: ["SemiBold", "Semibold", "Semi Bold", "DemiBold"],
  700: ["Bold"], 800: ["ExtraBold", "Extra Bold", "Heavy"], 900: ["Black", "Heavy"]
};
function mcpFindFont(family, weight, italic) {
  if (typeof app.fonts === "undefined" || !app.fonts.getFontsByFamilyNameAndStyleName) return null;
  var w = Math.round((weight || 400) / 100) * 100;
  if (w < 100) w = 100;
  if (w > 900) w = 900;
  var styles = MCP_WEIGHT_STYLES[w] || ["Regular"];
  for (var i = 0; i < styles.length; i++) {
    var names = italic ? [styles[i] + " Italic", (w === 400 ? "Italic" : styles[i] + "Italic")] : [styles[i]];
    for (var n = 0; n < names.length; n++) {
      try {
        var hits = app.fonts.getFontsByFamilyNameAndStyleName(family, names[n]);
        if (hits && hits.length) return hits[0].postScriptName;
      } catch (e) {}
    }
  }
  return null;
}
function mcpStyleText(layer, ts, result) {
  if (!ts) return;
  var tp = layer.property("ADBE Text Properties").property("ADBE Text Document");
  var doc = tp.value;
  try { if (ts.size) doc.fontSize = ts.size; } catch (e) {}
  var ps = null;
  try { ps = ts.fontFamily ? mcpFindFont(ts.fontFamily, ts.fontWeight, ts.fontItalic) : null; } catch (e) {}
  if (ts.fontFamily && !ps) {
    mcpWarn(result, "font '" + ts.fontFamily + "' (weight " + (ts.fontWeight || 400) + ") not found in AE; used " + (ts.font || "the default font") + " on " + layer.name);
  }
  try { if (ps) doc.font = ps; else if (ts.font) doc.font = ts.font; } catch (e) {}
  try { if (ts.fill) { doc.fillColor = mcpHexToRgb(ts.fill); doc.applyFill = true; } } catch (e) {}
  try { if (ts.stroke) { doc.applyStroke = true; doc.strokeColor = mcpHexToRgb(ts.stroke); if (ts.strokeWidth) doc.strokeWidth = ts.strokeWidth; } } catch (e) {}
  try { if (ts.tracking !== undefined) doc.tracking = ts.tracking; } catch (e) {}
  try { if (ts.leading) { doc.autoLeading = false; doc.leading = ts.leading; } } catch (e) {}
  try {
    if (ts.justification === "center") doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    else if (ts.justification === "right") doc.justification = ParagraphJustification.RIGHT_JUSTIFY;
    else if (ts.justification === "left") doc.justification = ParagraphJustification.LEFT_JUSTIFY;
  } catch (e) {}
  try { tp.setValue(doc); } catch (e) {}
}
function mcpMakeShape(spec) {
  // spec: { vertices:[[x,y]...], inTangents?, outTangents?, closed? }
  var sh = new Shape();
  try { sh.vertices = spec.vertices; } catch (e) {}
  try { if (spec.inTangents) sh.inTangents = spec.inTangents; } catch (e) {}
  try { if (spec.outTangents) sh.outTangents = spec.outTangents; } catch (e) {}
  sh.closed = (spec.closed !== false);
  return sh;
}
function mcpBuildShape(layer, ss, result) {
  if (!ss) return;
  var root = layer.property("ADBE Root Vectors Group");
  var grp = root.addProperty("ADBE Vector Group");
  var cont = grp.property("ADBE Vectors Group");
  var kind = ss.kind || "rect";
  var w = (ss.size && ss.size[0]) || 200, h = (ss.size && ss.size[1]) || 200;
  if (kind === "ellipse") {
    var el = cont.addProperty("ADBE Vector Shape - Ellipse");
    try { el.property("ADBE Vector Ellipse Size").setValue([w, h]); } catch (e) {}
  } else if (kind === "star") {
    var st = cont.addProperty("ADBE Vector Shape - Star");
    try { st.property("ADBE Vector Star Outer Radius").setValue(w / 2); } catch (e) {}
  } else if (kind === "path") {
    var pa = cont.addProperty("ADBE Vector Shape - Group");
    try { pa.property("ADBE Vector Shape").setValue(mcpMakeShape(ss.path || {})); } catch (e) { mcpWarn(result, "path set fail: " + mcpErrStr(e)); }
  } else {
    var rc = cont.addProperty("ADBE Vector Shape - Rect");
    try { rc.property("ADBE Vector Rect Size").setValue([w, h]); } catch (e) {}
    if (ss.roundness) { try { rc.property("ADBE Vector Rect Roundness").setValue(ss.roundness); } catch (e) {} }
  }
  // STROKE BEFORE FILL: contents render top-of-list frontmost and addProperty appends
  // to the bottom, so adding stroke first leaves it above the fill (AE UI default).
  if (ss.stroke) {
    var sk = cont.addProperty("ADBE Vector Graphic - Stroke");
    try { sk.property("ADBE Vector Stroke Color").setValue(mcpHexToRgb(ss.stroke)); } catch (e) {}
    if (ss.strokeWidth) { try { sk.property("ADBE Vector Stroke Width").setValue(ss.strokeWidth); } catch (e) {} }
  }
  if (ss.fill) {
    var fl = cont.addProperty("ADBE Vector Graphic - Fill");
    try { fl.property("ADBE Vector Fill Color").setValue(mcpHexToRgb(ss.fill)); } catch (e) {}
  }
  if (ss.trim) {
    var tr = cont.addProperty("ADBE Vector Filter - Trim");
    try { if (ss.trim.start !== undefined) tr.property("ADBE Vector Trim Start").setValue(ss.trim.start); } catch (e) {}
    try { if (ss.trim.end !== undefined) tr.property("ADBE Vector Trim End").setValue(ss.trim.end); } catch (e) {}
    try { if (ss.trim.offset !== undefined) tr.property("ADBE Vector Trim Offset").setValue(ss.trim.offset); } catch (e) {}
  }
}
function mcpAddMasks(layer, masks, result) {
  if (!masks) return;
  for (var i = 0; i < masks.length; i++) {
    var m = masks[i];
    try {
      var mask = layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
      mask.property("ADBE Mask Shape").setValue(mcpMakeShape(m));
      if (m.mode === "subtract") mask.maskMode = MaskMode.SUBTRACT;
      else if (m.mode === "intersect") mask.maskMode = MaskMode.INTERSECT;
      else mask.maskMode = MaskMode.ADD;
      if (m.inverted) mask.inverted = true;
      if (m.opacity !== undefined) { try { mask.property("ADBE Mask Opacity").setValue(m.opacity); } catch (e2) {} }
      if (m.name) { try { mask.name = m.name; } catch (e3) {} }
    } catch (e) { mcpWarn(result, "mask fail: " + mcpErrStr(e)); }
  }
}
function mcpAddImage(comp, spec, result) {
  var p = spec.image && spec.image.path;
  if (p) {
    try { var f = new File(p); if (f.exists) { var io = app.project.importFile(new ImportOptions(f)); return comp.layers.add(io); } } catch (e) {}
    mcpWarn(result, "image missing -> placeholder: " + p);
  }
  return comp.layers.addSolid([0.5, 0.5, 0.5], (spec.name || "Image") + " (missing)", comp.width, comp.height, 1);
}
function mcpCreateLayer(comp, spec, result) {
  var layer; var t = spec.type;
  if (t === "text") { layer = comp.layers.addText((spec.text && spec.text.value) || ""); mcpStyleText(layer, spec.text, result); }
  else if (t === "shape") { layer = comp.layers.addShape(); mcpBuildShape(layer, spec.shape, result); }
  else if (t === "solid") { layer = comp.layers.addSolid(mcpHexToRgb((spec.solid && spec.solid.color) || "#808080"), spec.name || "Solid", comp.width, comp.height, 1); }
  else if (t === "null") { layer = comp.layers.addNull(); }
  else if (t === "adjustment") { layer = comp.layers.addSolid([1, 1, 1], spec.name || "Adjustment", comp.width, comp.height, 1); try { layer.adjustmentLayer = true; } catch (e) {} }
  else if (t === "image") { layer = mcpAddImage(comp, spec, result); }
  else { layer = comp.layers.addNull(); }
  if (spec.name) { try { layer.name = spec.name; } catch (e) {} }
  if (spec.blendMode) { try { layer.blendingMode = mcpBlend(spec.blendMode); } catch (e) {} }
  if (spec.threeD) { try { layer.threeDLayer = true; } catch (e) {} }
  if (spec.startTime !== undefined) { try { layer.startTime = spec.startTime; } catch (e) {} }
  if (spec.inPoint !== undefined)   { try { layer.inPoint = spec.inPoint; } catch (e) {} }
  if (spec.outPoint !== undefined)  { try { layer.outPoint = spec.outPoint; } catch (e) {} }
  return layer;
}
function mcpApplyTransform(layer, tr, isText) {
  if (!tr) return;
  var tg = mcpTransformGroup(layer);
  if (tr.anchor !== undefined) {
    if (tr.anchor instanceof Array) { try { tg.property("ADBE Anchor Point").setValue(tr.anchor); } catch (e) {} }
    else if (tr.anchor === "center" && isText) {
      try { var r = layer.sourceRectAtTime(0, false); tg.property("ADBE Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]); } catch (e) {}
    }
    // anchor:"center" on shape/solid/image/null is a no-op by design: shape content is
    // built centered on the layer origin, and solid/image/null anchors already default
    // to their visual center.
  }
  if (tr.position !== undefined) { try { tg.property("ADBE Position").setValue(tr.position); } catch (e) {} }
  if (tr.scale !== undefined)    { try { tg.property("ADBE Scale").setValue(tr.scale); } catch (e) {} }
  if (tr.rotation !== undefined) { try { tg.property("ADBE Rotate Z").setValue(tr.rotation); } catch (e) {} }
  if (tr.opacity !== undefined)  { try { tg.property("ADBE Opacity").setValue(tr.opacity); } catch (e) {} }
}
function mcpBuildLayerFull(comp, spec, result) {
  var layer = mcpCreateLayer(comp, spec, result);
  mcpApplyTransform(layer, spec.transform, spec.type === "text");
  mcpAddMasks(layer, spec.masks, result);
  mcpAddEffects(layer, spec.effects, result);
  if (spec.animations) {
    for (var i = 0; i < spec.animations.length; i++) {
      var an = spec.animations[i];
      var p = mcpResolveAnimProp(layer, an.property);
      if (p) mcpApplyAnim(p, an, result);
      else mcpWarn(result, "unresolved anim property: " + an.property);
    }
  }
  mcpApplyExpressions(layer, spec.expressions, result);
  return layer;
}
function mcpBuildScene(scene) {
  var result = { ok: true, created: [], warnings: [] };
  app.beginUndoGroup("MCP Build");
  try {
    var c = scene.comp || {};
    var masterName = mcpUniqueName(c.name || "Scene");
    var master = app.project.items.addComp(masterName, c.width || 1920, c.height || 1080, 1, c.duration || 10, c.fps || 30);
    if (c.bg) { try { master.bgColor = mcpHexToRgb(c.bg); } catch (e) {} }
    result.master = masterName;
    var scenes = scene.scenes || [];
    for (var si = 0; si < scenes.length; si++) {
      var sc = scenes[si];
      var pcName = mcpUniqueName(sc.name || ("Scene_" + (si + 1)));
      var pc = app.project.items.addComp(pcName, master.width, master.height, 1, sc.duration || master.duration, master.frameRate);
      if (c.bg) { try { pc.bgColor = mcpHexToRgb(c.bg); } catch (e) {} }
      var layers = sc.layers || [];
      var nameToLayer = {};
      for (var li = layers.length - 1; li >= 0; li--) {
        var lyr = mcpBuildLayerFull(pc, layers[li], result);
        if (layers[li].name) nameToLayer[layers[li].name] = lyr;
      }
      for (var lj = 0; lj < layers.length; lj++) {
        var ls = layers[lj];
        if (ls.parent && nameToLayer[ls.name] && nameToLayer[ls.parent]) { try { nameToLayer[ls.name].parent = nameToLayer[ls.parent]; } catch (e) {} }
      }
      var pcLayer = master.layers.add(pc);
      try { pcLayer.startTime = sc.start || 0; } catch (e) {}
      result.created.push(pcName);
    }
    try { master.openInViewer(); } catch (e) {}
    result.comp = masterName;
  } catch (e) {
    result.ok = false;
    result.error = mcpErrStr(e);
    try { if (e.line) result.error += " (line " + e.line + ")"; } catch (e2) {}
  }
  app.endUndoGroup();
  return result;
}
`;

// Minimal ES3 JSON.stringify for the standalone .jsx (bare ExtendScript has no JSON;
// the bridge polyfills it for the live path, but File > Scripts must self-provide).
const JSON_POLYFILL = `
if (typeof JSON === "undefined") { JSON = {}; }
if (!JSON.stringify) {
  JSON.stringify = function (v) {
    function q(s) {
      s = String(s).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"').replace(/\\n/g, "\\\\n").replace(/\\r/g, "\\\\r").replace(/\\t/g, "\\\\t");
      return '"' + s + '"';
    }
    function go(x) {
      if (x === null || x === undefined) return "null";
      var t = typeof x;
      if (t === "number") return isFinite(x) ? String(x) : "null";
      if (t === "boolean") return String(x);
      if (t === "string") return q(x);
      if (x instanceof Array) {
        var a = [];
        for (var i = 0; i < x.length; i++) a.push(go(x[i]));
        return "[" + a.join(",") + "]";
      }
      var o = [];
      for (var k in x) { if (x.hasOwnProperty(k)) o.push(q(k) + ":" + go(x[k])); }
      return "{" + o.join(",") + "}";
    }
    return go(v);
  };
}
`;

// U+2028/U+2029 are legal raw in JSON strings but are LINE TERMINATORS in ES3 —
// escape them so embedded scene data can never break the emitted script.
function jsonForES3(value, pretty) {
  return JSON.stringify(value, null, pretty ? 2 : undefined)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function builderCoreSource() {
  return BUILDER_CORE;
}

// Live path: full eval script that builds an embedded scene and returns JSON.
function buildSceneScript(scene) {
  return BUILDER_CORE + '\nJSON.stringify(mcpBuildScene(' + jsonForES3(scene) + '));';
}

// Portable path: a standalone .jsx that builds an embedded scene with no server.
function standaloneJsx(scene) {
  return '// Auto-generated by export-jsx.js — run via File > Scripts > Run Script File.\n' +
    '// Builds an editable AE comp from embedded scene-JSON. No server required.\n' +
    JSON_POLYFILL +
    BUILDER_CORE +
    '\nvar __scene = ' + jsonForES3(scene, true) + ';\n' +
    'var __r = mcpBuildScene(__scene);\n' +
    'if (__r && __r.ok === false) { alert("MCP build FAILED: " + __r.error); }\n' +
    'else if (__r && __r.warnings && __r.warnings.length) { alert("MCP build ok with " + __r.warnings.length + " warning(s):\\n" + __r.warnings.join("\\n")); }\n' +
    'try { $.writeln(JSON.stringify(__r)); } catch (e) {}\n';
}

module.exports = { builderCoreSource, buildSceneScript, standaloneJsx, jsonForES3, BUILDER_CORE, JSON_POLYFILL };
