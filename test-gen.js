// Quick test gen 1 frame qua HTTP. Chạy SAU KHI server.js đã start.
//
// Usage:  node test-gen.js
//
const url = 'http://localhost:3737/gen-frame';
const body = {
  frame_id: 'TEST',
  prompt: 'minimalist abstract geometric composition, soft gradient',
  reference_files: [],
  download: true,
};

console.log('POST', url);
const r = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const data = await r.json();
console.log('Status:', r.status);
console.log(JSON.stringify(data, null, 2));
