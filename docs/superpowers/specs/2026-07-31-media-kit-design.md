# 本地媒体整理工具（media-kit）设计文档

日期：2026-07-31

## 目标

给定一个本地文件夹，一次性完成三件事：

1. **去重** — 完全相同的图片/视频只保留一份
2. **格式统一** — HEIC/HEIF 转 JPG
3. **瘦身** — 视频压制为 H.265 / 1080p / 30fps / 约 2Mbps；图片压到 3MB 以内

交互形态为本地网页：`npm start` 后浏览器打开 `localhost:7788`，选择文件夹即可处理。

## 非目标（明确不做）

- 不做相似图片识别（感知哈希），只按字节内容判重
- 不做一键撤销按钮（`_trash` + manifest 已足够手工回滚）
- 不做云端/远程处理，不做多用户
- 不特殊处理 Live Photo 伴生 `.MOV`（按普通视频处理）

## 技术选型与理由

| 决策 | 选择 | 理由 |
|---|---|---|
| 运行形态 | 本地 Node 服务 + 浏览器 UI | 浏览器内 ffmpeg.wasm 速度约为原生 1/20，大文件爆内存；HEIC 解码 Chrome 不原生支持 |
| 依赖 | 零第三方 npm 包 | 只需 `http`/`fs`/`crypto`/`child_process`，安装即用 |
| 视频编码器 | `hevc_videotoolbox` | Apple 芯片硬件编码，1080p 约 5-10 倍实时速度 |
| HEIC 转换 | `sips`（macOS 内置） | 保留 EXIF，比 ffmpeg 可靠 |
| 图片压缩 | `sips` | 同上，且能保留元数据 |
| 原文件处理 | 原地替换 + `_trash` 回收站 | 兼顾省空间与可回滚 |
| 去重标准 | 文件大小分组 + SHA-256 | 零误判 |

**平台约束**：依赖 `sips`，仅支持 macOS。依赖 `ffmpeg`/`ffprobe` 在 `$PATH` 中且编译时启用了 `hevc_videotoolbox`。

## 文件夹路径获取

浏览器出于安全策略不暴露本地绝对路径（`showDirectoryPicker()` 同样不暴露）。提供三条并存的路径获取方式：

1. **拖拽**（主路径）：前端通过 `webkitGetAsEntry()` 取得顶层文件夹名及内部若干文件的相对路径与大小，POST 给服务端。服务端在 `~/Downloads`、`~/Desktop`、`~/Pictures`、`~/Documents` 及其一级子目录中查找同名文件夹，用文件清单交叉校验。唯一匹配直接采用；多个匹配返回候选列表供点选；零匹配提示改用方式 2/3。
2. **内置目录浏览器**：服务端 `GET /api/ls?path=` 返回子目录列表，前端从 `~` 开始逐级点入，"选择此文件夹"确认。
3. **粘贴绝对路径**：文本框直接输入，服务端校验存在性与是否为目录。

## 架构

```
media-kit/
  package.json
  server.js          HTTP 路由 + SSE 进度推送 + 静态文件
  lib/
    scan.js          递归扫描、扩展名分类
    dedup.js         size 分组 → SHA-256 → 判重
    image.js         HEIC 转换 + 超限压缩
    video.js         ffprobe 分析 + ffmpeg 压制 + 进度解析
    queue.js         带并发上限的任务队列
    trash.js         移入 _trash + manifest 记录
    plan.js          扫描结果 → 处理计划（预演清单）
  public/
    index.html
    app.js
    style.css
```

### 模块职责

- **scan.js** — 输入根目录，输出 `{images: [...], videos: [...]}`。每项含 `path`（绝对）、`rel`（相对根目录）、`size`、`mtime`。跳过 `_trash/`、`.` 开头的隐藏文件与目录。
- **dedup.js** — 输入文件列表，输出重复组 `[{keep, remove: [...]}]`。不执行删除。
- **image.js** — 单文件处理，输入路径与选项，输出 `{action, outPath, before, after}`。不知道队列与进度的存在。
- **video.js** — 同上，额外通过回调上报百分比进度。
- **queue.js** — `run(tasks, concurrency, onProgress)`，与业务无关。
- **trash.js** — `moveToTrash(rootDir, filePath, reason)`，维护 manifest。
- **plan.js** — 组合 scan + dedup + probe 结果，产出可展示的预演清单，不执行任何写操作。

### HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/resolve` | 拖拽的文件夹名 + 文件清单 → 候选绝对路径 |
| GET | `/api/ls?path=` | 目录浏览器列出子目录 |
| POST | `/api/scan` | 扫描并返回处理计划（只读，不修改任何文件） |
| POST | `/api/run` | 按计划执行，返回 jobId |
| GET | `/api/events?jobId=` | SSE 推送进度与最终报告 |

## 处理流水线

### 阶段 1：去重

1. 按 `size` 分组，丢弃只有单个成员的组
2. 组内逐文件流式计算 SHA-256（并发 8）
3. 哈希相同者成组，保留 `mtime` 最早的（并列时按路径字典序取首个），其余移入 `_trash`

图片与视频统一参与去重，在其他阶段之前执行，避免对将被删除的文件做无用转码。

### 阶段 2：图片

**去重白名单**（仅参与去重，不做转换/压缩）：`webp gif bmp`

**完整处理白名单**：`jpg jpeg png heic heif tiff tif`

GIF 排除在压缩之外，因为 `sips` 会丢弃动画帧；`webp`/`bmp` 排除是因为 `sips` 对其支持不稳定。

1. **HEIC/HEIF 转换**：`sips -s format jpeg -s formatOptions 80 <in> --out <name>.jpg`，原文件移入 `_trash`
2. **超限压缩**（含上一步产出的 JPG）：仅当文件 >3MB 时触发
   - 最长边 >4000px 先缩至 4000（`sips -Z 4000`），此结果作为后续所有质量尝试的**共同输入源**
   - 质量依次尝试 85 → 75 → 65 → 55，**每次均从上述源文件重新编码**，绝不在前一次的输出上二次压缩（避免有损叠加）
   - 首个使结果 <3MB 的质量即采用；四次全部超限则采用 55 的结果
   - PNG：无 alpha 通道则转 JPG；有 alpha 保持 PNG，仅缩尺寸
3. 处理后以 `fs.utimes` 恢复原始 mtime/atime，保证照片按时间排序不乱
4. 若压缩结果反而更大，放弃、保留原文件

并发数 = `os.cpus().length`。

### 阶段 3：视频

扩展名白名单：`mp4 mov m4v avi mkv webm wmv flv mpg mpeg 3gp`

**触发条件**（任一命中即压缩）：长边 >1920、短边 >1080、帧率 >30、码率 >3Mbps

码率取 `ffprobe` 的 `format.bit_rate`；部分容器（如 mkv）该字段缺失，此时回退为 `文件字节数 × 8 ÷ 时长` 估算。时长同样缺失则视为码率未知，不以码率条件触发。

**目标尺寸计算**（在 JS 中完成，不交给 ffmpeg 的 `force_original_aspect_ratio`）：

保持宽高比，缩放至满足「短边 ≤1080 且 长边 ≤1920」的最大尺寸，绝不放大，宽高向下取偶。竖屏 1080×1920 因已满足约束而保持不变——这正是不能套用统一 1920×1080 盒子的原因（那样会错误缩成 607×1080）。

**编码参数**：

```
ffmpeg -i <in> \
  -c:v hevc_videotoolbox -tag:v hvc1 \
  -b:v 2M -maxrate 3M -bufsize 4M \
  -vf scale=W:H -r 30 \
  -c:a aac -b:a 128k \
  -map_metadata 0 -movflags +faststart \
  <tmp>.mp4
```

`-tag:v hvc1` 为必需项，缺失会导致 QuickTime 与"照片"App 无法播放。

**输出命名**：目标为同名 `.mp4`。若同目录已存在同名 `.mp4` 且非原文件本身，改用 `<name>-h265.mp4`。

**安全阀**：若输出体积 ≥ 原文件，删除输出、保留原文件，标记为"已跳过（压缩无收益）"。

**进度**：解析 ffmpeg stderr 中的 `time=HH:MM:SS.ss`，除以 ffprobe 得到的时长。

并发数 4（用户指定上限）。

## 数据安全

- **全程不调用 `fs.unlink` 删除用户文件**，所有"删除"均为移动至 `<根目录>/_trash/<原相对路径>`
- `_trash/manifest.json` 记录每条 `{action, from, to, reason, ts}`，供人工核对与回滚
- 所有写入采用「临时文件 → 校验 → 原子 `rename`」，中断不留半成品
- 仅处理扩展名白名单内的文件；`_trash/` 与隐藏文件/目录一律跳过
- 单文件失败仅记录错误并继续，不中断整批
- `/api/scan` 为纯只读操作，用户看到预演清单并确认后才会触发任何写入

## 界面

单页，三个阶段：

1. **选择** — 拖拽区 + 目录浏览器 + 路径输入框
2. **预演** — 统计卡片（图片数、视频数、重复组数及可回收空间、待转 HEIC 数、待压视频数、预计总节省），四个开关（去重 / HEIC 转换 / 视频压缩 / 图片压缩）默认全开，"开始处理"按钮
3. **执行** — 总进度条 + 分阶段状态 + 4 个视频槽位的实时文件名与百分比；完成后展示报告（各项动作计数、实际节省空间、`_trash` 路径提示、错误列表）

## 错误处理

| 场景 | 处理 |
|---|---|
| `ffmpeg`/`ffprobe` 不存在 | 启动时检测，页面顶部红条提示，禁用视频功能 |
| `hevc_videotoolbox` 不可用 | 启动时 `ffmpeg -encoders` 检测，缺失则提示并回退 `libx265` |
| 非 macOS（无 `sips`） | 启动时检测，禁用图片功能并提示 |
| 单文件转码失败 | 删除临时文件，保留原件，记入错误列表，继续下一个 |
| 目标路径已存在 | 视频改用 `-h265` 后缀；图片沿用同名（原件已入 `_trash`） |
| 磁盘写满 | 捕获 ENOSPC，中止整批并提示 |
| 处理中断（关页面） | 服务端任务继续跑完；重新打开页面可通过 jobId 重连 SSE |

## 测试策略

在 `test/fixtures/` 用脚本生成小体积样本（ffmpeg 合成测试视频、sips 生成图片），覆盖：

- 去重：同内容不同名、同大小不同内容、单文件组
- 尺寸计算：横屏 4K、竖屏 1080×1920、竖屏 4K、小于 1080p 的视频（不应放大）
- 触发判定：1080p30 但高码率、720p60、已达标视频（应跳过）
- 图片：HEIC 转换、>3MB 压缩迭代、带 alpha 的 PNG、压缩后反而变大
- trash：manifest 正确性、路径冲突

尺寸计算与触发判定为纯函数，优先用单元测试覆盖；转码链路用少量端到端测试验证。

## 成功标准

1. 拖入一个含 HEIC、重复文件、4K60 视频的文件夹，一次运行后：无重复文件、无 HEIC、所有视频为 H.265 且 ≤1080p/30fps、所有图片 <3MB
2. 原文件全部可在 `_trash/` 中找到，照片的 EXIF 与修改时间未丢失
3. 视频处理并发不超过 4，界面进度实时反映实际状态
4. 任何单个文件出错不影响其余文件的处理
