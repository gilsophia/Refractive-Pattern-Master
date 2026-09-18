# 折光纹工具箱 / Refraction pattern master

面向分层插画、卡牌与包装的 **Photoshop 折光纹母版生成工具**：按图层选择纹样、调整线宽与疏密，一键生成独立、可编辑的黑色矢量折光纹母版（PSD），并可逐组导出 PSD / PNG。

> **当前版本：v0.2**（核心 `2026-09-17d`；实测 Photoshop 2020 / 21.2，Windows / macOS 均可运行）

## 快速开始

1. 需要 **Adobe Photoshop（ExtendScript/JSX，实测 2020 / 21.2）**。整套文件夹可拷贝到任意盘符、任意（含中文）目录，脚本不写死路径。
2. 换电脑或换 Photoshop 版本后，先运行一次自检：Photoshop → **文件 → 脚本 → 浏览** → `scripts/selftest_core.jsx`（不建文档、不改文件），确认弹窗显示"核心自检 通过"。
3. 打开分层源 PSD，运行 **文件 → 脚本 → 浏览** → `scripts/generate_refraction_gui.jsx`，在列表里逐层确认纹样与参数；右侧小视窗会显示当前纹样的示意图。可勾选 **「读取画面内容」**（默认开）让"建议当前层 / 建议全部"先分析图层画面（每层约 1–2 秒），按画面走向与形态选纹样、修方向。点"生成"并选择输出目录。
4. 需要逐组文件时，打开生成的母版，运行 `scripts/export_groups.jsx`。

## 文件结构

```
scripts/      generate_refraction_gui.jsx  GUI 生成入口（推荐）
              generate_refraction.jsx      job.json 批处理入口
              refraction_core.jsx          核心库（两个入口共用，必须与入口同目录）
              export_groups.jsx            逐组导出
              selftest_core.jsx            环境/核心自检
              sample_shapes.jsx            纹样抽样测试（开发用）
              check_png.py                 PNG 导出的可选 QA（需要 Python + Pillow）
references/   设计规则、参数说明、验收记录（macro.md 宏说明 / design-logic.md 纹理逻辑 /
              design-vocabulary.md 设计语言 / 参数与示例.md / validation.md 实测记录）
texture-preview/  29 种纹样的黑白 PNG 预览（GUI 右侧小视窗使用）
工作流.md      完整工作流与验收标准
折光纹工具箱_功能说明.md   功能、默认参数、使用方法与移植说明
```

## 版本记录

### v0.2（核心 2026-09-17d）
- 新增纹样 **`content_flow`（随形流场）**：沿画面内容走向积分出流线，方向随形体无缝变化、按段收尾；GUI 下拉与预览图同步（现 29 种）。
- 纹样建议升级：名称规则给出**候选集**，再按全库用量轮换、并让相邻区块尽量不用同一种/同一族纹样（避不开时自动换 45° 方向）。
- 新增可选 **「读取画面内容」**：分析图层画面的主走向、方向一致度、弯折度、径向性与细节密度，用于选纹样与修正方向。
- 稳定性修复：剪贴蒙版层取样为空、稀疏大块层预算误报、失败层导致整次生成中止、退化小区域卡死、大面积高分辨率软渐变层转路径卡死（转路径前自动平滑轮廓，实测从卡住 17 分钟降到 2 秒）。
- 实测：010 全层版 87 层 / 59 组 / 0 失败（约 20 分钟）；精简版 5 层 / 4 组 / 0 失败（约 9 分钟）；两版均 `MASTER_QA PASS`。

### v0.1（首次分享）
- GUI 手动分配 + `job.json` 批处理 + 逐组导出 + 自检脚本；28 种纹样。

## 注意

- **不要把 `scripts/` 里的文件拆开**：入口脚本用自身路径定位同目录的 `refraction_core.jsx`。
- **保留 `texture-preview/` 与 `scripts/` 的相对位置**：GUI 用该目录中的“中文名-英文键名.png”显示纹样预览；预览是示意图，调整线宽与间隙不会实时重绘。缺少预览图时，GUI 会显示提示，仍可生成纹样。
- `job.json` 模式里的 `source_psd` / `output_dir` 是绝对路径，换机器要改；GUI 模式不需要。
- 生成过程与结果说明见 `zg_progress.txt`（逐层进度、蒙版简化、耗时）和 `master_report_*.txt`。
- 详细设计规则、参数、验收流程与已知限制见 `references/` 与 `折光纹工具箱_功能说明.md`。
