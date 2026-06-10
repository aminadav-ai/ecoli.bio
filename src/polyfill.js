// src/polyfill.js
// Polyfill global environment variables for Emscripten / WebAssembly compatibility in Cloudflare Workers

if (typeof globalThis.location === 'undefined') {
  globalThis.location = { href: 'http://localhost/' };
}
