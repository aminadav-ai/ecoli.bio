const text1 = "ацетат ('ac_e' concentration: 2.9844), D-лактат ('lac__D_e' concentration: 4.9022) и этанол ('etoh_e' concentration: 2.9072).";
const text2 = "Это _важный_ параметр.";

function parseMarkdownOld(text) {
  let escaped = text;
  escaped = escaped.replace(/_(.*?)_/g, '<em>$1</em>');
  return escaped;
}

function parseMarkdownNew(text) {
  let escaped = text;
  // Match underscores that are not surrounded by word characters (or are at word boundaries)
  // Since _ is a word character, we can require it to be preceded by a non-word character (or start of line)
  // and followed by a word character, etc.
  escaped = escaped.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<em>$1</em>');
  return escaped;
}

console.log('Old parser text1:', parseMarkdownOld(text1));
console.log('New parser text1:', parseMarkdownNew(text1));
console.log('Old parser text2:', parseMarkdownOld(text2));
console.log('New parser text2:', parseMarkdownNew(text2));
