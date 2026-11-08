# v2 发布手册（切换前请先读第一段）

## 0. 先搞清楚一件事：这个插件是 **link 安装**

```
~/.dsh/profiles/desktop/node_modules/dsh-local-memory
  → SymbolicLink → C:\...\default-workspace\dsh-local-memory
profile/package.json: "dsh-local-memory": "link:C:/.../dsh-local-memory"
```

**后果：改 `package.json` 的 `main` 就等于装机。** 不需要 `dsh plugin add`，不需要发布，
你下次重启桌面端，宿主就会去 `main` 指向的地方加载插件。

所以在没有明确确认之前，`main` **必须**继续指向 `./lib/index.js`（v1，正在用的那版）。
v2 目前只通过子路径暴露：`exports["./v2"]`、`["./v2/core"]`、`["./v2/client"]`。
这个状态是安全的：v2 代码在磁盘上、可测可彩排，但宿主不会加载它。

---

## 1. 切换前的验收（已全部通过，可复跑）

```powershell
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-local-memory
node scripts/verify-install.mjs    # 装机彩排：16 项，按声明入口加载并真跑工具/路由
node --test test/*.test.mjs        # 单元测试：129 项
node scripts/graph-preview.mjs     # 关系图快照（真实数据）
node scripts/ui-preview.mjs        # 界面离线预览
```

彩排通过 ≠ 真界面通过。**切换后仍然有 5 分钟的真人验证要做**（见第 4 节）。

---

## 2. 切换（一次改三处，改完重启宿主）

### 2.1 改入口

```jsonc
// package.json
"version": "2.0.0",
"main": "src/host/index.js",          // ← 原来是 lib/index.js
"exports": {
  ".": "./src/host/index.js",          // ← 原来指向 lib
  "./client": "./src/client/index.js", // ← 原来指向 lib/client.js
  "./v2": "./src/host/index.js",       // 保留，老引用不断链
  "./v2/core": "./src/core/index.js",
  "./v2/client": "./src/client/index.js",
  "./legacy": "./lib/index.js",        // 万一要拿旧版做对照
  "./package.json": "./package.json"
}
```

### 2.2 改装配（`cordis.patch.yml` 不用改）

`cordis.patch.yml` 只声明 `id` / `name`，入口由 `main` 决定，所以**不需要动**。

### 2.3 重启前先备份真实库

```powershell
$bk = 'C:\Users\Administrator\dsh-plugins\backups'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path "$bk\pre-v2-$stamp" | Out-Null
Copy-Item 'C:\Users\Administrator\.dsh\dsh-local-memory.json' "$bk\pre-v2-$stamp\" -Force
Get-FileHash 'C:\Users\Administrator\.dsh\dsh-local-memory.json' -Algorithm SHA256
```

记下这个 SHA256。v2 首次启动会**自动迁移**（只读 v1、写新库 `dsh-local-memory.db`），
迁移后真实 v1 文件应当**一个字节都没变**——重启后拿这个哈希复核。

### 2.4 重启桌面端

必须**完全退出**再开（托盘也退），插件入口在宿主启动时读一次。

---

## 3. 切换后第一件事：核对迁移

```powershell
# 新库出现了吗
Get-ChildItem 'C:\Users\Administrator\.dsh\dsh-local-memory.db*'

# v1 原始文件有没有被改（必须与 2.3 记的哈希一致）
(Get-FileHash 'C:\Users\Administrator\.dsh\dsh-local-memory.json' -Algorithm SHA256).Hash
```

再检查迁移结果（会在新库里写一条 meta）：

```powershell
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'\\.dsh\\dsh-local-memory.db');console.log(db.prepare('select v from memory_meta where k=?').get('migrated_from_v1'));console.log('条数',db.prepare('select count(*) c from memory').get().c)"
```

期望：`{"total":74,"inserted":74,"skipped":0,"invalid":0}` 之类，条数与 v1 一致。

---

## 4. 真人验证清单（5 分钟，必须做）

| # | 做什么 | 期望 |
|---|---|---|
| 1 | 打开 设置 → 本地记忆 | 出现「关系图 / 记忆列表 / 补标」三个页签 |
| 2 | 关系图页 | 有节点有连线，能拖能动，右下侧栏有说明 |
| 3 | 列表页搜一个中文两字词 | 能命中（如「人设」「插件」） |
| 4 | 补标页 | 顶部显示「还有 N 条未分类」，点「工作」后该条消失 |
| 5 | 对话里问一句「你记得我之前说过…」 | 模型能调 memory_search 命中，或自动回忆注入 |
| 6 | 让模型存一条新记忆 | 返回「已记住（id=…）」，列表页能看到 |

任何一项不对 → 立刻走第 5 节回滚。

---

## 5. 回滚（三条路，按严重程度选）

### 5.1 只是入口改坏了（最快，10 秒）

```powershell
cd C:\Users\Administrator\Documents\deepseek-harness\default-workspace\dsh-local-memory
git checkout master -- package.json cordis.patch.yml
# 彻底退出桌面端再开
```

### 5.2 数据被写坏了

```powershell
# v2 库整个挪开（别删，留着查问题）
Move-Item 'C:\Users\Administrator\.dsh\dsh-local-memory.db' 'C:\Users\Administrator\.dsh\dsh-local-memory.db.broken'
Move-Item 'C:\Users\Administrator\.dsh\dsh-local-memory.db-wal' 'C:\Users\Administrator\.dsh\dsh-local-memory.db-wal.broken' -ErrorAction SilentlyContinue
Move-Item 'C:\Users\Administrator\.dsh\dsh-local-memory.db-shm' 'C:\Users\Administrator\.dsh\dsh-local-memory.db-shm.broken' -ErrorAction SilentlyContinue

# v1 库还原（从 2.3 的备份）
Copy-Item '<备份目录>\dsh-local-memory.json' 'C:\Users\Administrator\.dsh\dsh-local-memory.json' -Force
```

### 5.3 彻底退回 v1 代码

```powershell
git checkout master          # 回到 v1 分支
# 或只退到重构前那个点：
git checkout 6b8d6a6 -- .
```

v1 的配置（`dsh-local-memory-config.json`）和 v2 的配置（`dsh-local-memory.v2-config.json`）
是**两个不同文件**，互不覆盖——这是刻意设计的，回滚不会互相污染。

---

## 6. 切换时可能踩的坑

| 坑 | 说明 |
|---|---|
| `node:sqlite` 不可用 | 只有 Node < 22.5 才会发生；本机宿主是 Node 24.21，不会遇到。真遇到会自动落回 JSON 后端（`dsh-local-memory.v2.json`） |
| 改完没重启 | 宿主启动时读一次入口，热改文件不生效。**必须完全退出桌面端** |
| 两个版本同时存在 | 不会：入口只有一个。但 v1 的 `lib/` 还在磁盘上，别手动去引用它 |
| 设置页有两个「本地记忆」 | 如果旧版还在记忆里：完全退出重开即可；两个 section 的 id 都是 `local-memory`，后来的会覆盖 |
| 迁移跑了两遍 | 不会：v2 用 meta 标记 `migrated_from_v1` 保证只跑一次，且迁移器本身幂等（已存在 id 跳过） |

---

## 7. 切换后才该做的事

- 把 `lib/` 删掉（在 git 里有基线 `6b8d6a6`，随时能捞回来）
- README/CHANGELOG 改成 v2 说明
- 打 tag `v2.0.0`
- 提交到 dshmarket（见记忆里的市场收录流程）
