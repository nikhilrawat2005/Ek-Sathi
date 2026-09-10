const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

async function main() {
  const dir = process.cwd();
  const files = [
    'EK SATHI Your AI Companion for Learning & Growth.pdf',
    'Ek Sathi — AI-Powered Student Companion Project Report.pdf'
  ];
  for (const f of files) {
    const p = path.join(dir, f);
    const dataBuffer = fs.readFileSync(p);
    try {
      const data = await pdfParse(dataBuffer);
      const out = path.join(dir, '_extract_' + f.replace(/[^\w\-.]/g,'_') + '.txt');
      fs.writeFileSync(out, data.text);
      console.log('WROTE', out, 'pages:', data.numpages);
    } catch (e) {
      console.log('FAILED', f, e.message);
    }
  }
}
main();
