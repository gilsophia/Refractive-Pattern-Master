# 本包验证记录

本次任务交付的是供下次使用的工作流与技能文件。用户给出了九张参考图片，未给出实际待加工 PSD 与最终尺寸。

## 已核实

- 已阅读用户参考图并分别整理发束流线、飘带随形、光环放射、背景分区、边饰与留白逻辑。
- 已核对 Adobe 的形状层、JSX 与 Photoshop 2020 技术路线，以及折光压纹供应商的公开说明；链接见 design-logic.md。
- 本机指定 `Photoshop.exe` 存在，文件产品版本 21.2。通过窗口工具发现 Adobe Photoshop 2020 主窗口。
- Skill Creator 的 `quick_validate.py` 已通过本包 SKILL.md 的结构验证。此项不证明 Photoshop 脚本能运行。
- 两个 JSX 已通过 JavaScript 语法解析；这不是 Photoshop API、ExtendScript 兼容性或导出结果证明。
- check_png.py 已用合成测试图验证：正常黑色透明线通过；白色可见像素、无透明背景、空图、不同画布尺寸均被拒绝。未用 Photoshop 实际导出 PNG 进行本机端到端验证。
- 文档相对链接已检查，均能解析到本包文件。

## Photoshop 运行验证（已实测，2026-09-08 补充）

已在本机 Photoshop 2020 (21.2) 通过 COM 实际生成 `塔.psd`、`Hat-Taro-折光纹.psd`、`卡背.psd` 的母版与逐层 PNG/PSD。但确认本机 COM 环境存在下列硬性限制，**矢量形状层无法通过脚本创建**：

### 可用（已实测）
- `loadTransparency`（`setd` 载入图层透明度为选区）、`selection.bounds`、`selection.fill`、`selection.select(bounds)`、`selection.invert`。
- `pathItems.add(name, subPathInfo[])`、`path.makeSelection(REPLACE)`、`path.remove()`。
- **通道布尔**：`channels.add()` → `selection.store(ch)` → `selection.load(ch, EXTEND/DIMINISH/INTERSECT)`。注意每次 `channels.add()` 后必须 `restoreRGB`（`activeChannels=[R,G,B]`），否则后续选区操作报「没有这种元素」。

### 不可用（会报错或返回 undefined）
- **矢量蒙版「Make」命令**：试了 8 种 Action Manager 写法全部报「命令"建立:"当前不可用」，无法创建 `SOLIDFILL`+矢量蒙版的形状层。
- **像素蒙版**：正确的 `null=Chnl/Chnl/Msk` 描述符同样报「Make 不可用」；`putClass(Nw,Chnl)` 虽不报错但不会真正挂到图层上。
- `selection.makeWorkPath()` 返回 `undefined`（选区→路径不可用）。
- `path.makeSelection(INTERSECT)` 报「没有这种元素」；须改用「存通道 + `selection.load(ch, INTERSECT)`」做交集。
- `selection.load(path, ...)` 报「非法参数」；从路径建选区只能用 `path.makeSelection`。

### 环境注意
- `doc.duplicate()` / `app.documents.add()` 会报「显示器没有足够空间停放」；先 `ShowWindow(hWnd, SW_RESTORE)` 恢复窗口即可。
- `layer.duplicate(targetDoc, ...)` 要求源文档处于最前（先 `app.activeDocument = src`）。
- **多批次填充 bug**：claimed 通道非空时，第二批次 fill 会铺满全画布；规避办法是每层单批一次 fill（BATCH 取大值）。
- **空/损坏智能对象**：隔离导出覆盖率为 0，但 `loadTransparency` 误报满画布；生成前先核对各层实际覆盖率。

### 结论
本机脚本只能产出「栅格黑线 + 通道裁切」的**草稿母版**（报告中须披露非矢量），再人工替换为手绘矢量形状（见 design-vocabulary.md）。严格矢量交付须在可交互的前台会话手工制作或经 Illustrator。

## 首次生产前的最小验证

1. 在 Photoshop 正常可交互状态，从“文件 → 脚本 → 浏览”运行 sample_shapes.jsx，选择测试输出目录。
2. 检查 master_shapes.psd 的三组均为黑色填充+矢量蒙版，放大检查三种纹区；确认可选中锚点，不是像素图片。
3. 检查 export_manifest.csv 对应的三个透明 PNG/PSD，PNG 使用 check_png.py 实测 Alpha、纯黑和同尺寸；重叠三个单组文件确认对位。
4. 小样合格后才处理真实源 PSD。实际人物/孔洞/蒙版/放射中心以及跨层间隙的生产验收，按 photoshop-workflow.md 另做，不能由矩形样张代替。

## 工作流与脚本能力边界

疏密逻辑与任意图层分配由 Codex 阅读技能后按当前源图执行；不是将任意 JSON 直接送进 Photoshop 的完整自动生成器。样张脚本只演示矩形区域内的平行、流线和鱼骨形状。逐组导出脚本需要事先制作好的纯黑形状输出组。PNG 检查脚本不能证明矢量最小尺寸。

## Photoshop 2020 (21.2) 实测：路径硬上限与读取速度（2026-09-16 补充）

用 `B&I Tarot Tower.psd`（2516×3756 @900 ppi）与合成路径在 Photoshop 2020 内实测，结论如下。这些数据是「clouds: 形状层建立失败: 非法参数」故障与整次生成过慢的根因。

### 路径硬上限（`pathItems.add()`）

| 项目 | 实测结果 |
|---|---|
| 单个子路径锚点数 | 1000 点通过；1001 点起抛「非法参数」 |
| 单条路径子路径数 | 1000 条通过；1001 条起抛「非法参数」 |
| 一条路径的总节点数 | 不设限（10 条×1000 点、240 条×25 点均通过） |

即：限制是**每个子路径 ≤1000 锚点**与**每条路径 ≤1000 子路径**，与总节点数无关。旧版 `contour` 用 1/4 线宽重采样外轮廓，900 ppi 下每条环带子路径可达 4000 点，必然触发该错误；区域蒙版路径同样有此隐患。

### 工作路径读取速度（DOM vs ActionManager）

同一工作路径，用 DOM 逐点读（`subPathItems[i].pathPoints[j].anchor/leftDirection/rightDirection`）与用 ActionManager（`putProperty(Path, workPath)` → `pathContents`）一次读回：

| 路径规模 | DOM 读取 | ActionManager 读取 | 数据一致性 |
|---|---|---|---|
| 1108 点 | 73–74 秒 | 4 毫秒 | — |
| 2877 点 | 491 秒 | 324 毫秒 | 2877 点全部一致，最大偏差 0 |
| 3731 点 / 2 子路径（含孔洞） | 717 秒 | 430 毫秒 | 3731 点全部一致，最大偏差 0 |

DOM 读取随点数呈 O(n²) 增长，是 109 层、约一小时那次运行的主要耗时来源。AM 描述符结构（已核对）：

```
pathContents(pathClass) → pathComponents(LIST)
  └ 每项: shapeOperation(ENUM: add/subtract/intersect/xor), subpathListKey(LIST)
       └ 每项: closedSubpath(BOOL), points(LIST)
            └ 每项: anchor/forward/backward(各为 Hrzn/Vrtc 的 pixelsUnit) + smooth(BOOL)
```

要点：AM 的 `forward` 对应 DOM 的 `leftDirection`、`backward` 对应 `rightDirection`；单位随标尺（标尺为像素时即像素）。AM 的 `smooth` 标志与 DOM 的 `PointKind` 不对应，故 `kind` 由控制点是否共线反向推断（只影响编辑手感，不影响曲线几何）。

核心库已据此改为「优先 AM + 首次与 DOM 比对标定 + 不一致自动回退 DOM」，并在 `zg_progress.txt` 记录实际使用的方式。

### 环境注意（补充）

- 通过 COM 驱动 Photoshop 时，`app.documents.add()` 可能报「显示器没有足够空间停放」；本次诊断后段该实例已无法新建文档，改用 `app.open()` 打开既有 PSD 完成验证。正常交互启动 Photoshop 不受影响。
- 本次诊断期间由 COM 启动过 Photoshop 实例，已关闭；未改动任何用户 PSD 与 Photoshop 首选项。

### 「避免重复生成」所用 API 实测（2026-09-16）

在 Photoshop 2020 (21.2) 内逐项验证，全部可用：

| 用途 | 调用 | 实测 |
|---|---|---|
| 新建占用通道 | `doc.channels.add()` + 立刻 `doc.activeChannels=[R,G,B]` | 成功；当前图层为普通图层（含 SOLIDFILL 形状层）时可靠，为组时曾失败，代码里会先切到组内首个图层 |
| 路径转选区 | `pathItem.makeSelection()` | 成功；注意 `pathItems.add` 的坐标是 **point**，须 px×72/ppi |
| 区域相减 | `selection.load(channel, SelectionType.DIMINISH)` | 成功；结果面积经 L 形用例核对（800²−400²=480000，精确一致） |
| 选区转回矢量 | `selection.makeWorkPath(tol)` + ActionManager 读回 | 成功，得到裁剪后的矢量子路径 |
| 累加并集 | `selection.store(channel, SelectionType.EXTEND)` | 成功；累加后原区域再相减得到空选区 |
| 判断全被覆盖 | `selection.bounds` 抛错 | 空选区读取 bounds 会抛「没有这种元素」，以此判定 `COVERED` |

另：`executeAction Mk Chnl` 方式新建通道在本机报「建立:当前不可用」，因此用 DOM 的 `channels.add()`。

### 单元类纹样密度实测（2026-09-16，600ppi / 线宽 0.15mm / 22.3mm 方块）

在 ExtendScript 里直接跑纹样生成函数并逐点计算「不同多边形之间的最小距离」（等价于线条中心距，净距 = 中心距 − 线宽）：

| 纹样 | 修改前 | 修改后 | 最小净距（下限 0.12mm） |
|---|---|---|---|
| `parallel`（基准） | 83 条 | 83 条 | 0.150 mm |
| `meander` | 约 2 条 | 17 条 | 0.166 mm |
| `herringbone` | 约 2 条 | 36 条 | 0.600 mm |
| `hex_lattice` | 约 2 格 | 195 格 | 0.238 mm |
| `carbon_fiber` | 约 2 根 | 100 根 | 0.300 mm |
| `scale` | 约 2 行 | 475 格 | 0.187 mm |
| `dot_field` | 约 2 行 | 361 点 | 0.301 mm |
| `checker` | — | 152 格 | 0.150 mm |

修改前的根因：这些纹样把 `wavelength_mm`（默认 12mm＝283px）直接当格子尺寸，与其它纹样的基准间距（线宽+中隙≈7px）差约 40 倍；另外 `meander` 的行距等于单元、`scale` 的相邻弧半径和恰好等于行距（相切）、`hex_lattice` 相邻六边形共边会叠线。现统一改为 `unitCellPx()` 由基准间距推导并把 `wavelength_mm` 夹在合理倍数内，并修正上述三处几何。

### 输出组嵌套与容器组（2026-09-16）

需求是「输出组按源图层层级嵌套、只关联父子级、不加剪辑蒙版」。实测要点：

- 组的**矢量蒙版会连带裁切组内子层**。而「避免重复生成」把父层的区域算成「父区域 − 已生成子区域」，如果直接嵌进父组，子层会被父组蒙版整片裁掉。因此对「下面还有要生成的子层」的层改成两层：容器组（无蒙版）+ `本层纹样` 子组（带区域蒙版），子层与纹样子组同级。
- 校验函数改为递归：按「带形状层的纹样组」计数并检查矢量蒙版，纯容器组允许无蒙版、不计数。
- `export_groups.jsx` 改为递归收集所有深度的 `ZG_OUT__` 组，只导出带形状层的纹样组，跳过隐藏组并写入 `skipped_hidden_groups.txt`。
- 逻辑用真实路径样本跑过：`卡面` / `卡面/motto` / `卡面/motto/motto-top` 等 11 条路径的「是否容器 / 归属父组」结果与源层级一致。
- **`LayerSet.move(target, ElementPlacement.INSIDE)` 在 2020 报「非法参数」**：007 那次 118 层里，凡是有子层的 20 层全部因此失败（日志里连续 20 条 `失败(已跳过该层) … 非法参数`，且失败点正好在「纹样完成」与「开始建形状层」之间，即容器组那几行代码）。现改为 `nestGroup()` 三写法容错 + 逐次校验 + 失败退回单层结构，不再让整层作废。
- 顺带发现：布尔相减后的选区在 `background`/`卡面` 这类「几乎整图」的层上会碎成 4000–5000 条子路径，`makeWorkPath` 一次要 18–22 秒；蒙版是裁切边界，已把该步容差放宽到 1.5 倍以减少碎片与耗时。

### 007 端到端复测（2026-09-16 20:25，118 层 / 1748×3402@600）

核心版本 2026-09-16e：**65 组、0 失败**，`MASTER_QA PASS`；「不折光命名(已生成但隐藏): 6 组」与用户手工整理的理想母版一致；「输出组父子级: 已嵌套 64 组, 失败 0 组, 容器组 20, **嵌套方式=2**」——即 `LayerSet.move(INSIDE)` 在 2020 不可用，实际生效的是「借临时普通图层 PLACEBEFORE」的绕行写法。

耗时分布（同一份日志统计）：总 39.3 分钟 = 取样 7.1 分（其中临时文档复位 5.0 分，后段单层 5–8 秒，疑与取样文档累积历史/内存有关）+ 布尔相减 6.3 分 / 57 次 + 形状层 1.2 分 + 结构校验约 1 分 + **保存母版 14.2 分**（006 同规模仅 0.4 分）。据此做了三项调整：保存前先关闭取样文档、每 15 层把取样文档回退到初始历史状态、矢量蒙版写法首次成功后记住不再试错。

### 「没有足够空间停放新文档」实测（2026-09-16）

逐层 `documents.add` 建立取样临时文档、用完即关的写法，在 2516×3756@900 的图上跑到第 9 层左右开始报：

```
不能创建新文档，因为在显示器上没有足够的空间来停放它们。
请尝试在“首选项”中取消“以选项卡方式打开文档”。
```

一旦触发，后续每次 `documents.add` 都失败（004 那次 109 层里 91 层因此失败），说明这是 Photoshop 窗口/文档停放状态被耗尽，与内存和图层内容无关。规避办法是**全程只建一个取样临时文档并复用**（每层用「新建空图层 + 删除其余图层」复位，复位后校验透明），这也是当前实现。若在其它机器上仍出现，可按提示关闭「以选项卡方式打开文档」、重启 Photoshop 或复位工作区。
