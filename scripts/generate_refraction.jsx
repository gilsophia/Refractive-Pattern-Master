#target photoshop
/* 折光纹母版生成宏 (job.json 模式)  — 与 generate_refraction_gui.jsx 共用 refraction_core.jsx
 * 运行: 文件 -> 脚本 -> 浏览 -> generate_refraction.jsx -> 选择 job.json
 * 依据 job.json 的图层分配生成纯黑矢量折光纹, 另存独立母版 PSD。不覆盖源 PSD。 */
(function () {
    function jsonParse(text) {
        var i = 0;
        function ws() { while (i < text.length && (text.charAt(i) === ' ' || text.charAt(i) === '\t' || text.charAt(i) === '\n' || text.charAt(i) === '\r')) i++; }
        function err(m) { throw new Error('JSON parse error @' + i + ': ' + m); }
        function expect(t) { for (var k = 0; k < t.length; k++) if (text.charAt(i + k) !== t.charAt(k)) err('expected ' + t); i += t.length; }
        function value() {
            ws(); var ch = text.charAt(i);
            if (ch === '{') return obj();
            if (ch === '[') return arr();
            if (ch === '"') return str();
            if (ch === 't') { expect('true'); return true; }
            if (ch === 'f') { expect('false'); return false; }
            if (ch === 'n') { expect('null'); return null; }
            return number();
        }
        function obj() {
            i++; var o = {}; ws();
            if (text.charAt(i) === '}') { i++; return o; }
            while (true) {
                ws(); var key = str(); ws();
                if (text.charAt(i) !== ':') err('expected :'); i++;
                o[key] = value(); ws();
                var ch = text.charAt(i);
                if (ch === ',') { i++; continue; }
                if (ch === '}') { i++; return o; }
                err('expected , or }');
            }
        }
        function arr() {
            i++; var a = []; ws();
            if (text.charAt(i) === ']') { i++; return a; }
            while (true) {
                a.push(value()); ws();
                var ch = text.charAt(i);
                if (ch === ',') { i++; continue; }
                if (ch === ']') { i++; return a; }
                err('expected , or ]');
            }
        }
        function str() {
            i++; var out = '';
            while (true) {
                var ch = text.charAt(i);
                if (ch === '') err('unterminated string');
                if (ch === '"') { i++; return out; }
                if (ch === '\\') {
                    var e = text.charAt(i + 1); i += 2;
                    if (e === 'n') out += '\n';
                    else if (e === 't') out += '\t';
                    else if (e === 'r') out += '\r';
                    else if (e === 'b') out += '\b';
                    else if (e === 'f') out += '\f';
                    else if (e === 'u') { var hex = text.substring(i, i + 4); i += 4; out += String.fromCharCode(parseInt(hex, 16)); }
                    else out += e;
                } else { out += ch; i++; }
            }
        }
        function number() {
            var start = i;
            if (text.charAt(i) === '-' || text.charAt(i) === '+') i++;
            while (i < text.length && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++;
            if (text.charAt(i) === '.') { i++; while (i < text.length && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++; }
            if (text.charAt(i) === 'e' || text.charAt(i) === 'E') { i++; if (text.charAt(i) === '-' || text.charAt(i) === '+') i++; while (i < text.length && text.charAt(i) >= '0' && text.charAt(i) <= '9') i++; }
            var ss = text.substring(start, i);
            if (ss === '') err('expected number');
            return parseFloat(ss);
        }
        ws(); var v = value(); ws();
        if (i < text.length) err('trailing characters');
        return v;
    }

    var scriptDir = '';
    /* 定位同目录的 refraction_core.jsx: 用 $.fileName 推导, 不写死绝对路径。
     * 先用 Folder.getFiles 取 File 对象(不做路径字符串拼接), 兼容中文路径与不同系统的分隔符。 */
    function findCore() {
        var sf = null;
        try { sf = new File($.fileName); } catch (e0) { sf = null; }
        if (!sf || !sf.exists || !sf.parent) return null;
        scriptDir = sf.parent.fsName;
        try {
            var cand = sf.parent.getFiles('refraction_core.jsx');
            if (cand && cand.length) return cand[0];
        } catch (e1) {}
        var f = new File(scriptDir + '/refraction_core.jsx');
        return f.exists ? f : null;
    }
    var coreFile = findCore();
    if (!coreFile) {
        alert('找不到 refraction_core.jsx。请确认它与 generate_refraction.jsx 在同一个目录里, 并用 文件→脚本→浏览 打开本脚本。' + (scriptDir ? ('\n脚本目录: ' + scriptDir) : ''));
        return;
    }
    $.evalFile(coreFile);

    function main() {
        var jobFile = File.openDialog('选择 job.json 配置文件');
        if (!jobFile) return;
        jobFile.encoding = 'UTF-8';
        if (!jobFile.open('r')) throw new Error('无法读取 job.json');
        var text = jobFile.read(); jobFile.close();
        if (text.charAt(0) === '\uFEFF') text = text.substring(1);
        var job = jsonParse(text);

        var src = null, openedSrc = false;
        try {
            if (job.source_psd) { src = app.open(new File(String(job.source_psd))); openedSrc = true; }
            else if (app.documents.length) { src = app.activeDocument; }
            else { throw new Error('job.json 未指定 source_psd，且没有打开任何 PSD。'); }

            var ppi = src.resolution, wpx = src.width.as('px'), hpx = src.height.as('px');
            if (job.canvas && job.canvas.width_mm && job.canvas.height_mm) {
                var cppi = job.canvas.resolution_ppi || ppi;
                wpx = Math.round(job.canvas.width_mm * cppi / 25.4); hpx = Math.round(job.canvas.height_mm * cppi / 25.4); ppi = cppi;
            }

            var layers = job.layers || [];
            if (!layers.length) throw new Error('job.json 的 layers 为空。');

            var config = {
                sourceDoc: src, widthPx: wpx, heightPx: hpx, ppi: ppi,
                outputDir: job.output_dir ? String(job.output_dir) : jobFile.parent.fsName,
                defaults: job.defaults || {},
                noOverlap: job.no_overlap !== false,
                layers: layers
            };
            var res = ZG.generate(config);
            var msg = '折光纹母版已生成 (' + res.count + ' 组):\n' + res.psd;
            if (res.failed && res.failed.length) {
                msg += '\n\n有 ' + res.failed.length + ' 层失败(已跳过, 其余正常输出):\n';
                for (var f = 0; f < res.failed.length && f < 8; f++) msg += '· ' + res.failed[f] + '\n';
                if (res.failed.length > 8) msg += '… 其余见 master_report 的 FAIL 行。\n';
            } else {
                msg += '\n\n首次运行请按 references/validation.md 最小验证步骤复查。';
            }
            alert(msg);
        } finally {
            if (openedSrc && src) src.close(SaveOptions.DONOTSAVECHANGES);
        }
    }

    try { main(); } catch (e) { alert('折光纹宏出错:\n' + (e && e.message ? e.message : String(e))); }
}());
