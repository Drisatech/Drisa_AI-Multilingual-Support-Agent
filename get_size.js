import fs from 'fs';
const data = fs.readFileSync('src/agent-identity.png');
const base64 = data.toString('base64');
fs.writeFileSync('base64_output.txt', base64);
console.log('Size:', data.length);
