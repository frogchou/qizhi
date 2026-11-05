# 栖知“今日”页面视觉优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以原创叶片品牌标识、可辨识的文件类型图标和统一的表格字体层级，提升“今日”文件列表的协调性与信息密度。

**Architecture:** 新增两个无第三方依赖的 React SVG 组件：品牌标识组件只负责栖知叶片图形，文件图标组件根据扩展名映射视觉类型。`TodayPage` 仅负责传入文件路径，所有尺寸、状态配色和表格层级由 `App.css` 统一管理。

**Tech Stack:** React 19、TypeScript、内联 SVG、CSS、Vitest、Testing Library、Playwright/Tauri 开发渲染。

**Spec:** `docs/superpowers/specs/2026-10-30-today-ui-polish-design.md`

## Global Constraints

- 不引入第三方图标依赖，不复制 Microsoft、Adobe 等产品 Logo。
- 不修改 NTFS 索引、JEV 判断、RAGFlow 上传及现有文件操作行为。
- 1280×820 为主要验收尺寸，最低支持现有 1024×680 窗口。
- 保留单行文件列表、纵向滚动、长文件名省略和现有右键菜单。

## Review Focus

- 大写扩展名、无扩展名及未知扩展名必须得到稳定的通用文件图标。
- 超长中英文文件名必须保持单行省略，不能挤压时间、状态和操作列。
- “评估中、有价值、低价值、无法解析、评估失败”五种状态均需保持可读且不抢夺文件名焦点。
- 1024×680 下不得产生横向滚动或隐藏“操作”列。
- 文件行、排序按钮、价值按钮和打开按钮必须保留清晰的键盘焦点态。

---

### Task 1: 品牌叶片标识

**Files:**
- Create: `apps/desktop/src/components/BrandLogo.tsx`
- Create: `apps/desktop/src/components/BrandLogo.test.tsx`
- Modify: `apps/desktop/src/components/AppSidebar.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Produces: `BrandLogo({ className?: string }): JSX.Element`，输出原创叶片 SVG。

- [ ] **Step 1: Write the failing test**

新增测试 `renders_the_leaf_brand_mark_without_a_letter_placeholder`，断言侧栏包含 `.brand-logo` SVG，且不再渲染黑底字母 `Q`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @qizhi/desktop test -- --run src/components/BrandLogo.test.tsx`
Expected: FAIL，因为 `BrandLogo` 尚不存在且侧栏仍渲染 `Q`。

- [ ] **Step 3: Implement the leaf SVG and sidebar integration**

创建 `BrandLogo`，使用 32×32 viewBox、深绿色叶片轮廓和浅绿色叶脉；在 `AppSidebar` 中替换 `.brand-mark`。CSS 固定 32px，不依赖字体字符。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @qizhi/desktop test -- --run src/components/BrandLogo.test.tsx`
Expected: PASS。

### Task 2: 文件类型图标系统

**Files:**
- Create: `apps/desktop/src/components/FileTypeIcon.tsx`
- Create: `apps/desktop/src/components/FileTypeIcon.test.tsx`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/App.css`

**Interfaces:**
- Produces: `fileVisualType(path: string): FileVisualType`。
- Produces: `FileTypeIcon({ path }: { path: string }): JSX.Element`。
- `FileVisualType`: `pdf | word | sheet | slides | markdown | text | code | data | generic`。

- [ ] **Step 1: Write the failing mapping and rendering tests**

测试大小写扩展名映射、未知/无扩展名回退，以及 Word、PDF、Markdown、代码图标拥有各自的 `data-file-kind` 与可读 title。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @qizhi/desktop test -- --run src/components/FileTypeIcon.test.tsx`
Expected: FAIL，因为组件尚不存在。

- [ ] **Step 3: Implement the SVG badge component**

创建统一 22×24px 文档轮廓，使用 CSS 变量设置低饱和类型色，并以 `PDF/W/X/P/MD/TXT/</>/{} `等简短标记区分类型；未知类型使用通用文档图标。

- [ ] **Step 4: Integrate into TodayPage**

将当前 `<span className="file-icon">▤</span>` 替换为 `<FileTypeIcon path={file.canonicalPath} />`，保持文件名省略和单行布局。

- [ ] **Step 5: Run component and Today tests**

Run: `pnpm --filter @qizhi/desktop test -- --run src/components/FileTypeIcon.test.tsx src/features/today/today.test.tsx`
Expected: PASS。

### Task 3: 表格视觉层级与交互状态

**Files:**
- Modify: `apps/desktop/src/App.css`
- Modify: `apps/desktop/src/features/today/TodayPage.tsx`
- Modify: `apps/desktop/src/features/today/today.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `FileTypeIcon`。
- Produces: 状态修饰类 `value-tag status-pending|status-valuable|status-low|status-unsupported|status-error`。

- [ ] **Step 1: Write the failing status-class test**

扩展 TodayPage 测试，断言五种 JEV 状态映射到稳定的状态类，且“打开”按钮保持可访问名称。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @qizhi/desktop test -- --run src/features/today/today.test.tsx`
Expected: FAIL，因为当前只有统一 `.value-tag`。

- [ ] **Step 3: Implement compact typography and status styling**

修正无效的 `font: 600 12px inherit` 简写，改用独立 `font-size`/`font-weight`；设置文件名 14px、辅助信息/状态/操作 12px、行高 40px。为五种状态添加低饱和配色，将“打开”改为紧凑图标按钮并补充 `:focus-visible`。

- [ ] **Step 4: Tune columns and controls**

在 1024px 最小窗口下保证名称列弹性收缩，固定时间/来源/状态/操作列的紧凑宽度；统一筛选栏高度、边框和圆角，避免横向滚动。

- [ ] **Step 5: Run frontend tests and checks**

Run: `pnpm --filter @qizhi/desktop test -- --run && pnpm --filter @qizhi/desktop check`
Expected: 所有测试和检查通过。

### Task 4: 实际渲染验收与打包

**Files:**
- Modify only if rendered QA exposes a mismatch: `apps/desktop/src/App.css`, `apps/desktop/src/features/today/TodayPage.tsx`
- Output: temporary screenshots outside the repository

**Interfaces:**
- Consumes: Tasks 1–3 的最终 UI。

- [ ] **Step 1: Start the development renderer**

Run: `pnpm --filter @qizhi/desktop dev -- --host 127.0.0.1`
Expected: Vite 在本机端口启动且无编译错误。

- [ ] **Step 2: Validate rendered UI**

通过可用的 Browser 插件优先检查页面身份、DOM、控制台、1280×820 截图和至少一次筛选/排序交互；若桌面命令在纯浏览器环境不可用，使用完整的测试数据入口或 Playwright 现有流程验证视觉层。

- [ ] **Step 3: Validate minimum desktop viewport**

在 1024×680 检查列宽、长文件名、滚动条、状态标签和操作列，无横向溢出。

- [ ] **Step 4: Run complete regression suite**

Run: `cargo test` in `apps/desktop/src-tauri` and `pnpm --filter @qizhi/desktop test -- --run` from repo root.
Expected: 0 failures。

- [ ] **Step 5: Build and fingerprint installer**

Run: `pnpm --filter @qizhi/desktop tauri build`，随后计算 NSIS 安装包 SHA-256。
Expected: `apps/desktop/src-tauri/target/release/bundle/nsis/栖知_0.1.0_x64-setup.exe` 生成成功。
