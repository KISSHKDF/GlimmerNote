/* 错题本 2.0 · 极简 Markdown 渲染
 * 语义与桌面壳 C# Md 类逐条对齐（教训：'|' 开头不一定是表格——`|a−1|+|a−2|` 是绝对值，
 * 只有「本行 | 开头 + 次行 |---| 分隔行」才是表；其余必须当段落收下，绝不丢行——M0015/M0020 踩过）。 */
(function () {
  const esc = s => (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function inline(s) {
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }
  const isSep = l => /^\s*\|[\s:\-|]+\|\s*$/.test(l) && /-/.test(l);

  CTB.md = function (md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    let out = '', i = 0;
    while (i < lines.length) {
      const L = lines[i];
      if (!L.trim()) { i++; continue; }
      if (/^\s*-{3,}\s*$/.test(L)) { out += '<hr>'; i++; continue; }
      /* 表格 */
      if (/^\s*\|/.test(L) && i + 1 < lines.length && isSep(lines[i + 1])) {
        const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        out += '<table><thead><tr>' + cells(L).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          const cs = cells(lines[i]); i++;
          if (cs.length === 1 && !cs[0]) continue;
          out += '<tr>' + cs.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
        }
        out += '</tbody></table>';
        continue;
      }
      const hm = L.match(/^\s*(#{1,6})\s+(.*)$/);
      if (hm) { const lv = hm[1].length; out += '<h' + lv + '>' + inline(hm[2]) + '</h' + lv + '>'; i++; continue; }
      if (/^\s*>/.test(L)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(inline(lines[i].trimStart().replace(/^>\s?/, ''))); i++; }
        out += '<blockquote>' + q.join('<br>') + '</blockquote>';
        continue;
      }
      if (/^\s*\d+\.\s/.test(L)) {
        out += '<ol>';
        while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) { out += '<li>' + inline(lines[i].replace(/^\s*\d+\.\s/, '')) + '</li>'; i++; }
        out += '</ol>';
        continue;
      }
      if (/^\s*[-*+]\s/.test(L)) {
        out += '<ul>';
        while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) { out += '<li>' + inline(lines[i].replace(/^\s*[-*+]\s/, '')) + '</li>'; i++; }
        out += '</ul>';
        continue;
      }
      /* 段落：块内单换行 → <br>；任何情况下不丢行 */
      const para = [];
      while (i < lines.length) {
        const t = lines[i];
        if (!t.trim()) break;
        if (/^\s*-{3,}\s*$/.test(t)) break;
        if (/^\s*>/.test(t)) break;
        if (/^\s*\|/.test(t) && i + 1 < lines.length && isSep(lines[i + 1])) break;
        if (/^\s*#{1,6}\s/.test(t)) break;
        if (/^\s*\d+\.\s/.test(t) || /^\s*[-*+]\s/.test(t)) break;
        para.push(inline(t)); i++;
      }
      if (!para.length) { para.push(inline(lines[i])); i++; }
      out += '<p>' + para.join('<br>') + '</p>';
    }
    return out;
  };
})();
