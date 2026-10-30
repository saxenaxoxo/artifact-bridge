// pipeline/ae/read.jsx.js  (Phase 1 — deep generic reader)
//
// Returns ES3 ExtendScript source that recursively serializes any AE property tree
// to JSON. One recursive routine (`mcpReadProp`) = reads "everything", future-proof.
//
// Node-side is modern JS; the EMITTED string is strict ES3 (plan §3.4): var,
// function declarations, classic for-loops, no arrow/let/const/map. JSON.stringify
// is available in the bridge. Keyframe indices are 1-based. Everything is wrapped in
// try/catch so a single throwing node never aborts the whole read.
//
// IMPORTANT: never store a live AE object (TextDocument, Shape, MarkerValue) as a
// value — JSON.stringify would later walk it and some getters throw (e.g. box-text
// only fields). mcpSanitize() reduces every value to JSON-safe primitives/arrays.

'use strict';

const READER_CORE = `
// ===== MCP deep reader (ES3) =====
function mcpSafeText(v) {
  var t = {};
  try { t.text = v.text; } catch (e) {}
  try { t.font = v.font; } catch (e) {}
  try { t.fontSize = v.fontSize; } catch (e) {}
  try { t.fillColor = v.fillColor; } catch (e) {}
  try { t.applyFill = v.applyFill; } catch (e) {}
  try { t.applyStroke = v.applyStroke; if (v.applyStroke) { t.strokeColor = v.strokeColor; t.strokeWidth = v.strokeWidth; } } catch (e) {}
  try {
    var j = v.justification;
    if (j == ParagraphJustification.LEFT_JUSTIFY) t.justification = "left";
    else if (j == ParagraphJustification.CENTER_JUSTIFY) t.justification = "center";
    else if (j == ParagraphJustification.RIGHT_JUSTIFY) t.justification = "right";
    else t.justification = "" + j;
  } catch (e) {}
  try { t.tracking = v.tracking; } catch (e) {}
  try { t.leading = v.leading; } catch (e) {}
  return t;
}
function mcpSafeShape(v) {
  var s = { kind: "shape" };
  try { s.vertices = v.vertices; } catch (e) {}
  try { s.inTangents = v.inTangents; } catch (e) {}
  try { s.outTangents = v.outTangents; } catch (e) {}
  try { s.closed = v.closed; } catch (e) {}
  return s;
}
function mcpSanitize(v, pvt) {
  try { if (pvt == PropertyValueType.TEXT_DOCUMENT) return mcpSafeText(v); } catch (e) {}
  try { if (pvt == PropertyValueType.SHAPE) return mcpSafeShape(v); } catch (e) {}
  if (v === null || v === undefined) return null;
  var tp = typeof v;
  if (tp === "number" || tp === "string" || tp === "boolean") return v;
  if (v instanceof Array) {
    var out = [];
    try {
      for (var i = 0; i < v.length; i++) {
        var e = v[i]; var et = typeof e;
        out.push((et === "number" || et === "string" || et === "boolean") ? e : (e instanceof Array ? e : null));
      }
    } catch (er) { return null; }
    return out;
  }
  return null; // unknown object (Shape, MarkerValue, etc.) — omit to stay JSON-safe
}
function mcpInterp(t) {
  try {
    if (t == KeyframeInterpolationType.LINEAR) return "linear";
    if (t == KeyframeInterpolationType.BEZIER) return "bezier";
    if (t == KeyframeInterpolationType.HOLD)   return "hold";
  } catch (e) {}
  return "" + t;
}
function mcpEaseArr(arr) {
  var out = [];
  try { for (var i = 0; i < arr.length; i++) { out.push({ speed: arr[i].speed, influence: arr[i].influence }); } } catch (e) {}
  return out;
}
function mcpReadProp(prop, depth) {
  var node = {};
  try { node.name = prop.name; } catch (e) {}
  try { node.matchName = prop.matchName; } catch (e) {}
  var isGroup = false;
  try { isGroup = (prop.propertyType == PropertyType.INDEXED_GROUP || prop.propertyType == PropertyType.NAMED_GROUP); } catch (e) {}
  if (isGroup) {
    node.kind = "group";
    node.properties = [];
    if (depth > 0) {
      var n = 0; try { n = prop.numProperties; } catch (e) {}
      for (var i = 1; i <= n; i++) {
        try { node.properties.push(mcpReadProp(prop.property(i), depth - 1)); }
        catch (e2) { node.properties.push({ error: "" + e2 }); }
      }
    }
    return node;
  }
  node.kind = "property";
  var pvt = null; try { pvt = prop.propertyValueType; } catch (e) {}
  try { if (prop.expression) { node.expression = prop.expression; node.expressionEnabled = prop.expressionEnabled; } } catch (e) {}
  var nk = 0; try { nk = prop.numKeys; } catch (e) {}
  node.numKeys = nk;
  if (nk > 0) {
    node.keys = [];
    for (var k = 1; k <= nk; k++) {
      var key = {};
      try { key.t = prop.keyTime(k); } catch (e) {}
      var rawkv = null, gotkv = false; try { rawkv = prop.keyValue(k); gotkv = true; } catch (e) {}
      key.v = gotkv ? mcpSanitize(rawkv, pvt) : null;
      try { key.inInterp = mcpInterp(prop.keyInInterpolationType(k)); } catch (e) {}
      try { key.outInterp = mcpInterp(prop.keyOutInterpolationType(k)); } catch (e) {}
      try { key.inEase = mcpEaseArr(prop.keyInTemporalEase(k)); } catch (e) {}
      try { key.outEase = mcpEaseArr(prop.keyOutTemporalEase(k)); } catch (e) {}
      try {
        if (prop.isSpatial) {
          key.inTan = mcpSanitize(prop.keyInSpatialTangent(k), null);
          key.outTan = mcpSanitize(prop.keyOutSpatialTangent(k), null);
          key.roving = prop.keyRoving(k);
        }
      } catch (e) {}
      node.keys.push(key);
    }
  } else {
    var rawv = null, gotv = false; try { rawv = prop.value; gotv = true; } catch (e) {}
    node.value = gotv ? mcpSanitize(rawv, pvt) : null;
  }
  return node;
}
function mcpReadLayer(layer, depth) {
  var L = {};
  try { L.index = layer.index; } catch (e) {}
  try { L.name = layer.name; } catch (e) {}
  try { L.matchName = layer.matchName; } catch (e) {}
  try { L.enabled = layer.enabled; } catch (e) {}
  try { L.inPoint = layer.inPoint; } catch (e) {}
  try { L.outPoint = layer.outPoint; } catch (e) {}
  try { L.startTime = layer.startTime; } catch (e) {}
  try { L.threeD = layer.threeDLayer; } catch (e) {}
  try { L.blendMode = "" + layer.blendingMode; } catch (e) {}
  try { L.label = layer.label; } catch (e) {}
  try { L.parent = layer.parent ? layer.parent.name : null; } catch (e) {}
  try { L.isText = (layer instanceof TextLayer); } catch (e) {}
  try { L.isShape = (layer instanceof ShapeLayer); } catch (e) {}
  try { L.isCamera = (layer instanceof CameraLayer); } catch (e) {}
  try {
    if (layer instanceof TextLayer) {
      var td = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
      L.text = mcpSafeText(td);
    }
  } catch (e) {}
  L.root = [];
  var n = 0; try { n = layer.numProperties; } catch (e) {}
  for (var i = 1; i <= n; i++) {
    try { L.root.push(mcpReadProp(layer.property(i), depth)); }
    catch (e4) { L.root.push({ error: "" + e4 }); }
  }
  return L;
}
function mcpReadComp(comp, depth) {
  var C = {};
  try { C.name = comp.name; } catch (e) {}
  try { C.id = comp.id; } catch (e) {}
  try { C.width = comp.width; } catch (e) {}
  try { C.height = comp.height; } catch (e) {}
  try { C.duration = comp.duration; } catch (e) {}
  try { C.frameRate = comp.frameRate; } catch (e) {}
  try { C.pixelAspect = comp.pixelAspect; } catch (e) {}
  try { C.bgColor = comp.bgColor; } catch (e) {}
  try { C.numLayers = comp.numLayers; } catch (e) {}
  C.layers = [];
  var nl = 0; try { nl = comp.numLayers; } catch (e) {}
  for (var i = 1; i <= nl; i++) {
    try { C.layers.push(mcpReadLayer(comp.layer(i), depth)); }
    catch (e2) { C.layers.push({ error: "" + e2 }); }
  }
  return C;
}
function mcpFindComp(nameOrId) {
  var n = 0; try { n = app.project.numItems; } catch (e) {}
  for (var i = 1; i <= n; i++) {
    var it = app.project.item(i);
    if (it instanceof CompItem) {
      if (typeof nameOrId === "number") { if (it.id === nameOrId) return it; }
      else if (it.name === nameOrId) return it;
    }
  }
  return null;
}
function mcpReadProject(depth) {
  var P = { items: [], comps: [] };
  try { P.aeVersion = app.version; } catch (e) {}
  try { P.file = app.project.file ? app.project.file.fsName : null; } catch (e) {}
  try { P.numItems = app.project.numItems; } catch (e) {}
  var n = 0; try { n = app.project.numItems; } catch (e) {}
  for (var i = 1; i <= n; i++) {
    var it; try { it = app.project.item(i); } catch (e) { continue; }
    var meta = {};
    try { meta.name = it.name; } catch (e) {}
    try { meta.id = it.id; } catch (e) {}
    try { meta.typeName = it.typeName; } catch (e) {}
    P.items.push(meta);
    try { if (it instanceof CompItem) P.comps.push(mcpReadComp(it, depth)); } catch (e) {}
  }
  return P;
}
`;

function readerCoreSource() {
  return READER_CORE;
}

// HARD LIMITS — a whole-project deep dump once wedged/crashed AE (BUG-19): a depth-8
// recursion over ~50 comps with thousands of keyframes never returned and AE reset to
// the last save. Project-wide dumps are therefore SHALLOW BY DESIGN (depth <= 3, enough
// for items/layers/top-level props); deep reads must be scoped to ONE comp at a time
// (depth <= 12). For a deep sweep, iterate comps and call compDumpScript per comp.
const MAX_PROJECT_DEPTH = 3;
const MAX_COMP_DEPTH = 12;

// Full project dump -> JSON string (eval returns the string; bridge passes through).
// SHALLOW: depth is clamped to MAX_PROJECT_DEPTH. Use compDumpScript for deep reads.
function projectDumpScript(depth) {
  if (depth === undefined || depth === null) depth = MAX_PROJECT_DEPTH;
  depth = Math.min(depth, MAX_PROJECT_DEPTH);
  return READER_CORE + '\nJSON.stringify(mcpReadProject(' + depth + '));';
}

// Single comp dump by name (string) or id (number) — the ONLY deep-read entry point.
function compDumpScript(nameOrId, depth) {
  if (depth === undefined || depth === null) depth = MAX_COMP_DEPTH;
  depth = Math.min(depth, MAX_COMP_DEPTH);
  const { jsonForES3 } = require('./builder-core.jsx.js');
  return READER_CORE +
    '\n(function(){ var c = mcpFindComp(' + jsonForES3(nameOrId) + ');' +
    ' return c ? JSON.stringify(mcpReadComp(c, ' + depth + ')) : JSON.stringify({error:"comp not found"}); })();';
}

module.exports = { readerCoreSource, projectDumpScript, compDumpScript, READER_CORE };
