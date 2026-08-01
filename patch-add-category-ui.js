const fs = require('fs');
const p = 'src/index.js';
let c = fs.readFileSync(p, 'utf8');

const oldColors = `const CATEGORY_COLORS = {
  UNFEST: '#7ab8ff', UNFILM: '#4ade80', UNCINEMA: '#3b82f6',
  UNLIVE: '#22d3ee', UNDEMO: '#facc15', UNFOLD: '#f97316',
};`;
if (!c.includes(oldColors)) { console.log('COLORS NOT FOUND'); process.exit(1); }
const newColors = `const CATEGORY_COLORS = {
  UNFEST: '#7ab8ff', UNFILM: '#4ade80', UNCINEMA: '#3b82f6',
  UNLIVE: '#22d3ee', UNDEMO: '#facc15', UNFOLD: '#f97316',
  SPONSOR: '#e879f9', 'MANAGEMENT/SETUP': '#a3a3a3', SYSTEM: '#fb7185',
};`;
c = c.replace(oldColors, newColors);

const oldList = `const categoryList = ['UNFEST', 'UNFILM', 'UNCINEMA', 'UNLIVE', 'UNDEMO', 'UNFOLD'];`;
if (!c.includes(oldList)) { console.log('LIST NOT FOUND'); process.exit(1); }
const newList = `const categoryList = ['UNFEST', 'UNFILM', 'UNCINEMA', 'UNLIVE', 'UNDEMO', 'UNFOLD', 'SPONSOR', 'MANAGEMENT/SETUP', 'SYSTEM'];`;
c = c.replace(oldList, newList);

fs.writeFileSync(p, c);
console.log('OK');
