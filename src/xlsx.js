'use strict';
// Minimal .xlsx reader (no packages): returns [{ name, rows: [[cell, ...], ...] }] with text values.
const fs = require('fs');
const zlib = require('zlib');

function unzip(buf) {
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an .xlsx file (zip directory not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken .xlsx file');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

function textOf(xml) {
  // all <t>…</t> runs inside one <si> or <is>
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1] ? decode(m[1]) : '';
  return out;
}

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(file) {
  const files = unzip(fs.readFileSync(file));
  const get = (n) => (files[n] ? files[n]().toString('utf8') : '');
  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(ss))) shared.push(textOf(m[1]));

  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const relMap = {};
  const relRe = /<Relationship\b[^>]*>/g;
  while ((m = relRe.exec(rels))) {
    const id = (m[0].match(/\bId="([^"]+)"/) || [])[1];
    const target = (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
    if (id && target) relMap[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
  }
  const sheets = [];
  const shRe = /<sheet\b[^>]*>/g;
  while ((m = shRe.exec(wb))) {
    const name = decode((m[0].match(/\bname="([^"]*)"/) || [])[1] || '');
    const rid = (m[0].match(/\br:id="([^"]+)"/) || [])[1];
    const path = relMap[rid];
    if (!path || !files[path]) continue;
    const xml = get(path);
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let r;
    while ((r = rowRe.exec(xml))) {
      const row = [];
      const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let c;
      while ((c = cRe.exec(r[1]))) {
        const attrs = c[1];
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
        const inner = c[2] || '';
        let val = '';
        if (type === 'inlineStr') val = textOf(inner);
        else {
          const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          if (v !== undefined) val = type === 's' ? shared[Number(v)] ?? '' : decode(v);
        }
        const idx = ref ? colIndex(ref) : row.length;
        row[idx] = val;
      }
      rows.push(Array.from(row, (x) => (x === undefined ? '' : String(x))));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

module.exports = { readXlsx };
