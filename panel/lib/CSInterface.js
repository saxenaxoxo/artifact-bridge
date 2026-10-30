/**
 * Minimal vendored CSInterface for AE Replica Studio.
 *
 * The official Adobe CSInterface.js is a thin wrapper over the injected
 * `window.__adobe_cep__` bridge; this panel only needs evalScript, the host
 * environment, system paths, and theme info, so we vendor exactly that surface
 * (same method names/semantics as Adobe's v12 library) instead of 1,100 lines.
 */
/* eslint-disable no-unused-vars */

function SystemPath() {}
SystemPath.EXTENSION = "extension";
SystemPath.USER_DATA = "userData";

function CSInterface() {}

/** Run ExtendScript in the host engine. callback receives the string result
 *  (or the literal "EvalScript error." on a host-side throw). */
CSInterface.prototype.evalScript = function (script, callback) {
  callback = callback || function () {};
  window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getHostEnvironment = function () {
  return JSON.parse(window.__adobe_cep__.getHostEnvironment());
};

CSInterface.prototype.getSystemPath = function (pathType) {
  var path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
  var OSVersion = this.getOSInformation();
  if (OSVersion.indexOf("Windows") >= 0) path = path.replace("file:///", "");
  else if (OSVersion.indexOf("Mac") >= 0) path = path.replace("file://", "");
  return path;
};

CSInterface.prototype.getOSInformation = function () {
  return navigator.platform.indexOf("Mac") >= 0 ? "Mac OS X" : "Windows";
};

/** Panel background color from the host theme (AE skin), as {red,green,blue}. */
CSInterface.prototype.getBackgroundColor = function () {
  try {
    var env = this.getHostEnvironment();
    return env.appSkinInfo.panelBackgroundColor.color;
  } catch (e) {
    return { red: 38, green: 38, blue: 38 };
  }
};

CSInterface.prototype.addEventListener = function (type, listener) {
  window.__adobe_cep__.addEventListener(type, listener);
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { CSInterface: CSInterface, SystemPath: SystemPath };
}
