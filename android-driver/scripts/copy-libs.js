// Copies the Supabase browser library into www/lib so the app works offline-first
// (no CDN inside the Android app).
const fs = require('fs'), path = require('path');
const src = require.resolve('@supabase/supabase-js/dist/umd/supabase.js');
fs.mkdirSync(path.join(__dirname, '..', 'www', 'lib'), { recursive: true });
fs.copyFileSync(src, path.join(__dirname, '..', 'www', 'lib', 'supabase.js'));
console.log('copied supabase.js');
