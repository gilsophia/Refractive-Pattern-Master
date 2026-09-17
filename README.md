# 折光纹工具箱 / Refraction pattern master

面向分层插画、卡牌与包装的 **Photoshop 折光纹母版生成工具**：按图层选择纹样、调整线宽与疏密，一键生成独立、可编辑的黑色矢量折光纹母版（PSD），并可逐组导出 PSD / PNG。

## 快速开始

1. 需要 **Adobe Photoshop（ExtendScript/JSX，实测 2020 / 21.2）**。整套文件夹可拷贝到任意盘符、任意（含中文）目录，脚本不写死路径。
2. 换电脑或换 Photoshop 版本后，先运行一次自检：Photoshop → **文件 → 脚本 → 浏览** → `scripts/selftest_core.jsx`（不建文档、不改文件），确认弹窗显示"核心自检 通过"。
3. 打开分层源 PSD，运行 **文件 → 脚本 → 浏览** → `scripts/generate_refraction_gui.jsx`，在列表里逐层确认纹样与参数，点"生成"并选择输出目录。
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
references/   设计规则、参数说明、验收记录
工作流.md      完整工作流与验收标准
折光纹工具箱_功能说明.md   功能、默认参数、使用方法与移植说明
```

## 注意

- **不要把 `scripts/` 里的文件拆开**：入口脚本用自身路径定位同目录的 `refraction_core.jsx`。
- `job.json` 模式里的 `source_psd` / `output_dir` 是绝对路径，换机器要改；GUI 模式不需要。
- 生成过程与结果说明见 `zg_progress.txt`（逐层进度、蒙版简化、耗时）和 `master_report_*.txt`。
- 详细设计规则、参数、验收流程与已知限制见 `references/` 与 `折光纹工具箱_功能说明.md`。
