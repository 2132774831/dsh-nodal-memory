/**
 * dsh-local-memory v2 — 浏览器半侧（设置页「本地记忆」）
 *
 * 手写 ModuleLoader bundle，**无需构建步骤**：注册 id 必须等于 loader entry 名。
 *
 * 两个页签：
 *   1) 关系图 —— 手写 canvas 力导向布局（不引任何图库），看记忆怎么扎堆、哪些是孤岛
 *   2) 列表   —— 搜索 / 新增 / 编辑 / 删除 / 恢复
 *
 * 所有数据来自 Host 半侧的 HTTP 接口（/dsh-local-memory/*），前端不自己算关系——
 * 边是服务端算好的（见 src/core/graph.js 里的四类确定性关系与防毛线球防线）。
 *
 * 布局算法是纯函数、无 DOM 依赖，并且通过 exports.__internals 暴露给单元测试
 * （见 test/client.test.mjs）——动画最容易出的 bug 是"坐标变 NaN 后整张图消失"，
 * 那种 bug 只能在数学层面抓。
 */

window.__ModuleLoader__.load({
  id: 'dsh-local-memory',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;
    const { useState, useEffect, useRef, useCallback } = react;

    const API = '/dsh-local-memory';

    /* ════════════════════════════════════════════════════════════════════════
     * 一、纯函数部分（可测）
     * ════════════════════════════════════════════════════════════════════════ */

    /** 记忆类别 → 颜色。unknown 用中性灰，避免历史数据抢视觉焦点。 */
    const KIND_COLORS = {
      work: '#4a90d9',
      preference: '#d9a04a',
      emotion: '#d95a8a',
      unknown: '#8a8f98',
    };

    const KIND_LABELS = {
      work: '工作',
      preference: '偏好',
      emotion: '情感',
      unknown: '未分类',
    };

    /** 边的视觉编码：共现最粗最亮，时间相邻最淡 */
    /* ════════════════════════════════════════════════════════════════════════
     * 二、样式
     * ════════════════════════════════════════════════════════════════════════ */

    const CSS = `
      .__lm2_root { display:flex; flex-direction:column; gap:12px; font-size:13px; }
      .__lm2_tabs { display:flex; gap:4px; border-bottom:1px solid rgba(128,128,128,.25); }
      .__lm2_tab { padding:6px 14px; cursor:pointer; border:none; background:none;
        color:inherit; opacity:.65; border-bottom:2px solid transparent; font-size:13px; }
      .__lm2_tab:hover { opacity:.9; }
      .__lm2_tab--on { opacity:1; border-bottom-color:#4a90d9; font-weight:600; }
      .__lm2_bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .__lm2_btn { padding:4px 10px; border-radius:5px; cursor:pointer; font-size:12px;
        border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.10); color:inherit; }
      .__lm2_btn:hover { background:rgba(128,128,128,.20); }
      .__lm2_btn:disabled { opacity:.45; cursor:default; }
      .__lm2_btn--on { border-color:#4a90d9; background:rgba(74,144,217,.18); }
      .__lm2_input { padding:4px 8px; border-radius:5px; font-size:12px; color:inherit;
        border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.08); }
      .__lm2_hint { opacity:.6; font-size:12px; }
      .__lm2_err { color:#d9534f; font-size:12px; }
        border:1px solid rgba(128,128,128,.22); border-radius:8px; overflow:hidden;
        background:rgba(128,128,128,.04); }
        font-size:11px; opacity:.75; pointer-events:none; flex-wrap:wrap; max-width:80%; }
      .__lm2_side { width:300px; flex:0 0 300px; overflow:auto; max-height:520px;
        border:1px solid rgba(128,128,128,.22); border-radius:8px; padding:10px; }
      .__lm2_sideTitle { font-weight:600; margin-bottom:6px; }
      .__lm2_meta { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; font-size:11px; opacity:.8; }
      .__lm2_tag { padding:1px 6px; border-radius:9px; background:rgba(128,128,128,.18); }
      .__lm2_body { white-space:pre-wrap; line-height:1.55; font-size:12px; }
      .__lm2_list { display:flex; flex-direction:column; gap:8px; }
      .__lm2_item { border:1px solid rgba(128,128,128,.22); border-radius:8px; padding:8px 10px; }
      .__lm2_itemHead { display:flex; justify-content:space-between; gap:8px; align-items:center; }
      .__lm2_mono { font-family:ui-monospace,Consolas,monospace; font-size:11px; opacity:.55; }
      .__lm2_stat { font-size:12px; opacity:.75; }
    `;

    let styleInjected = false;
    function ensureStyle() {
      if (styleInjected || typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin="dsh-local-memory"]')) {
        styleInjected = true;
        return;
      }
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin', 'dsh-local-memory');
      tag.textContent = CSS;
      document.head.appendChild(tag);
      styleInjected = true;
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 三、工具
     * ════════════════════════════════════════════════════════════════════════ */

    function ageLabel(ms) {
      const days = (Date.now() - ms) / 86400000;
      if (days < 1) return '今天';
      if (days < 2) return '昨天';
      if (days < 7) return Math.floor(days) + ' 天前';
      if (days < 30) return Math.floor(days / 7) + ' 周前';
      if (days < 180) return Math.floor(days / 30) + ' 个月前';
      const d = new Date(ms);
      return d.getFullYear() + ' 年 ' + String(d.getMonth() + 1).padStart(2, '0') + ' 月';
    }

    /**
     * 轻量行内渲染：记忆正文里常带 markdown（`**重点**`、`\`code\``、`[文字](链接)`），
     * 原样显示会满屏星号。这里只做"去掉语法符号、保留文字"，不做完整 markdown——
     * 记忆是要读的事实，不是要排版的文章。
     */
    function inlineText(input) {
      return String(input == null ? '' : input)
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .trim();
    }

    /**
     * 截断。**在 JS 里截，不靠 CSS 高度裁**：
     * CSS 裁剪依赖行高和容器高度，换个字体/缩放就裁得不对；
     * 字符串截断在任何渲染器里都确定生效。
     */
    function compact(input, max) {
      const text = inlineText(input);
      return text.length > max ? text.slice(0, max) + '…' : text;
    }

    async function jsonFetch(url, init) {
      const res = await fetch(url, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
      return data;
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 五、列表页签
     * ════════════════════════════════════════════════════════════════════════ */

    function ListTab() {
      const [rows, setRows] = useState([]);
      const [total, setTotal] = useState(0);
      const [query, setQuery] = useState('');
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [editing, setEditing] = useState(null);
      const [draft, setDraft] = useState('');
      const [showDeleted, setShowDeleted] = useState(false);

      const load = useCallback(async (q) => {
        setBusy(true);
        setError('');
        try {
          const params = new URLSearchParams({ limit: '60' });
          if (q) params.set('q', q);
          if (showDeleted) params.set('includeDeleted', '1');
          const data = await jsonFetch(API + '/memories?' + params.toString());
          setRows(data.memories || []);
          setTotal(data.total || 0);
        } catch (e) {
          setError('读取失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [showDeleted]);

      useEffect(() => { load(''); }, [load]);

      const save = async (id) => {
        setBusy(true);
        try {
          await jsonFetch(API + '/memories/' + encodeURIComponent(id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: draft }),
          });
          setEditing(null);
          await load(query);
        } catch (e) {
          setError('保存失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const act = async (id, action) => {
        setBusy(true);
        try {
          if (action === 'delete') {
            await jsonFetch(API + '/memories/' + encodeURIComponent(id), { method: 'DELETE' });
          } else {
            await jsonFetch(API + '/memories/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
          }
          await load(query);
        } catch (e) {
          setError('操作失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: '__lm2_root' },
        h('div', { className: '__lm2_bar' },
          h('input', {
            className: '__lm2_input',
            placeholder: '搜索记忆（中文二字也会命中）',
            value: query,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') load(query); },
            style: { width: '260px' },
          }),
          h('button', { className: '__lm2_btn', onClick: () => load(query), disabled: busy }, '搜索'),
          h('button', { className: '__lm2_btn', onClick: () => { setQuery(''); load(''); }, disabled: busy }, '显示全部'),
          h('button', {
            className: '__lm2_btn' + (showDeleted ? ' __lm2_btn--on' : ''),
            onClick: () => setShowDeleted((v) => !v),
          }, showDeleted ? '含已删：开' : '含已删：关'),
          h('span', { className: '__lm2_stat' }, `共 ${total} 条`),
          error ? h('span', { className: '__lm2_err' }, error) : null,
        ),
        h('div', { className: '__lm2_list' },
          rows.length === 0
            ? h('div', { className: '__lm2_hint' }, busy ? '读取中…' : '没有匹配的记忆。')
            : rows.map((rec) => h('div', { className: '__lm2_item', key: rec.id },
              h('div', { className: '__lm2_itemHead' },
                h('div', { className: '__lm2_meta' },
                  rec.project ? h('span', { className: '__lm2_tag' }, rec.project) : null,
                  rec.kind !== 'unknown' ? h('span', { className: '__lm2_tag' }, KIND_LABELS[rec.kind] || rec.kind) : null,
                  h('span', null, ageLabel(rec.createdAt)),
                  rec.accessCount ? h('span', null, '用过 ' + rec.accessCount + ' 次') : null,
                  rec.deletedAt ? h('span', { className: '__lm2_tag', style: { background: 'rgba(217,83,79,.25)' } }, '已删除') : null,
                ),
                h('span', { className: '__lm2_mono' }, rec.id),
              ),
              editing === rec.id
                ? h('div', null,
                  h('textarea', {
                    className: '__lm2_input',
                    value: draft,
                    rows: 4,
                    style: { width: '100%', marginTop: '6px' },
                    onChange: (e) => setDraft(e.target.value),
                  }),
                  h('div', { className: '__lm2_bar', style: { marginTop: '6px' } },
                    h('button', { className: '__lm2_btn', onClick: () => save(rec.id), disabled: busy }, '保存'),
                    h('button', { className: '__lm2_btn', onClick: () => setEditing(null) }, '取消'),
                  ),
                )
                : h('div', { className: '__lm2_body' }, compact(rec.content, 160)),
              (rec.tags || []).length
                ? h('div', { className: '__lm2_meta' }, rec.tags.map((t) => h('span', { className: '__lm2_tag', key: t }, t)))
                : null,
              h('div', { className: '__lm2_bar', style: { marginTop: '6px' } },
                rec.deletedAt
                  ? h('button', { className: '__lm2_btn', onClick: () => act(rec.id, 'restore'), disabled: busy }, '恢复')
                  : h('button', {
                    className: '__lm2_btn',
                    onClick: () => { setEditing(rec.id); setDraft(rec.content); },
                    disabled: busy,
                  }, '编辑'),
                rec.deletedAt
                  ? h('button', { className: '__lm2_btn', onClick: () => act(rec.id, 'purge'), disabled: busy }, '彻底删除')
                  : h('button', { className: '__lm2_btn', onClick: () => act(rec.id, 'delete'), disabled: busy }, '删除'),
              ),
            )),
        ),
      );
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 六、补标页签
     * ════════════════════════════════════════════════════════════════════════ */

    const KIND_CHOICES = [
      { value: 'work', label: '工作' },
      { value: 'preference', label: '偏好' },
      { value: 'emotion', label: '情感' },
    ];

    const IMPORTANCE_CHOICES = [
      { value: 'key', label: '关键' },
      { value: 'important', label: '重要' },
      { value: 'casual', label: '随口' },
      { value: 'transient', label: '易过期' },
    ];

    /**
     * 补标：把 v1 迁移过来、没有分类的记忆逐条归位。
     *
     * 为什么不做"批量全选"：分类这件事必须逐条读正文才能判断，批量操作只会制造
     * 一堆看起来整齐其实错分的标签，比不分类更糟。所以这里一次只推进一条。
     */
    function ClassifyTab() {
      const [rows, setRows] = useState([]);
      const [unknownTotal, setUnknownTotal] = useState(0);
      const [showAll, setShowAll] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [tagDraft, setTagDraft] = useState({});
      const [notice, setNotice] = useState('');
      const [expanded, setExpanded] = useState({});

      const load = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const params = new URLSearchParams({ limit: '60' });
          if (!showAll) params.set('kind', 'unknown');
          const [list, state] = await Promise.all([
            jsonFetch(API + '/memories?' + params.toString()),
            jsonFetch(API + '/state'),
          ]);
          setRows(list.memories || []);
          const row = (state.stats && state.stats.byKind || []).find((k) => k.kind === 'unknown');
          setUnknownTotal(row ? row.c : 0);
        } catch (e) {
          setError('读取失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [showAll]);

      useEffect(() => { load(); }, [load]);

      const patch = useCallback(async (id, body) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
          await jsonFetch(API + '/memories/' + encodeURIComponent(id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          if (!showAll && body.kind && body.kind !== 'unknown') {
            // 分好类就不在这条队列里了
            setRows((rs) => rs.filter((r) => r.id !== id));
            setUnknownTotal((n) => Math.max(0, n - 1));
            setNotice('已归类');
          } else {
            setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...body } : r)));
          }
        } catch (e) {
          setError('保存失败：' + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [showAll]);

      const saveTags = (rec) => {
        const raw = tagDraft[rec.id];
        if (raw === undefined) return;
        const tags = String(raw).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean);
        patch(rec.id, { tags });
        setTagDraft((d) => { const next = { ...d }; delete next[rec.id]; return next; });
      };

      return h('div', { className: '__lm2_root' },
        h('div', { className: '__lm2_bar' },
          h('span', { className: '__lm2_stat' },
            showAll ? '全部记忆' : `还有 ${unknownTotal} 条未分类`),
          h('button', {
            className: '__lm2_btn' + (showAll ? ' __lm2_btn--on' : ''),
            onClick: () => setShowAll((v) => !v),
          }, showAll ? '只看未分类：关' : '只看未分类：开'),
          h('button', { className: '__lm2_btn', onClick: load, disabled: busy }, busy ? '处理中…' : '刷新'),
          notice ? h('span', { className: '__lm2_hint' }, notice) : null,
          error ? h('span', { className: '__lm2_err' }, error) : null,
        ),
        h('div', { className: '__lm2_hint', style: { marginBottom: '6px' } },
          '逐条读正文再归位。分类只影响检索排序与图的着色，写错了随时改，不丢记忆。'),
        rows.length === 0
          ? h('div', { className: '__lm2_hint' }, busy ? '读取中…' : (showAll ? '没有记忆。' : '没有未分类的记忆了 🎉'))
          : h('div', { className: '__lm2_list' },
            rows.map((rec) => h('div', { className: '__lm2_item', key: rec.id },
              h('div', { className: '__lm2_meta' },
                rec.project ? h('span', { className: '__lm2_tag' }, rec.project) : null,
                rec.kind !== 'unknown' ? h('span', { className: '__lm2_tag' }, KIND_LABELS[rec.kind] || rec.kind) : null,
                h('span', null, ageLabel(rec.createdAt)),
                h('span', { className: '__lm2_mono' }, rec.id),
              ),
              // 正文默认截到 220 字：补标只需要"够判断类别"的信息，
              // 全展开会让一屏只放得下 3 条，67 条要翻二十多屏
              h('div', { className: '__lm2_body', style: { margin: '6px 0' } },
                expanded[rec.id] ? inlineText(rec.content) : compact(rec.content, 220)),
              inlineText(rec.content).length > 220
                ? h('button', {
                  className: '__lm2_btn',
                  style: { marginBottom: '4px' },
                  onClick: () => setExpanded((e) => ({ ...e, [rec.id]: !e[rec.id] })),
                }, expanded[rec.id] ? '收起' : '展开全文')
                : null,

              // 类别
              h('div', { className: '__lm2_bar' },
                h('span', { className: '__lm2_hint', style: { minWidth: '52px' } }, '类别'),
                KIND_CHOICES.map((c) => h('button', {
                  key: c.value,
                  className: '__lm2_btn' + (rec.kind === c.value ? ' __lm2_btn--on' : ''),
                  disabled: busy,
                  onClick: () => patch(rec.id, { kind: c.value }),
                }, c.label)),
                h('button', {
                  className: '__lm2_btn' + (rec.kind === 'unknown' ? ' __lm2_btn--on' : ''),
                  disabled: busy,
                  onClick: () => patch(rec.id, { kind: 'unknown' }),
                }, '未分类'),
              ),

              // 重要度
              h('div', { className: '__lm2_bar' },
                h('span', { className: '__lm2_hint', style: { minWidth: '52px' } }, '重要度'),
                IMPORTANCE_CHOICES.map((c) => h('button', {
                  key: c.value,
                  className: '__lm2_btn' + (rec.importance === c.value ? ' __lm2_btn--on' : ''),
                  disabled: busy,
                  onClick: () => patch(rec.id, { importance: c.value }),
                }, c.label)),
              ),

              // 标签
              h('div', { className: '__lm2_bar' },
                h('span', { className: '__lm2_hint', style: { minWidth: '52px' } }, '标签'),
                h('input', {
                  className: '__lm2_input',
                  style: { flex: '1 1 200px' },
                  placeholder: '逗号或空格分隔',
                  value: tagDraft[rec.id] !== undefined
                    ? tagDraft[rec.id]
                    : (rec.tags || []).join(', '),
                  onChange: (e) => setTagDraft((d) => ({ ...d, [rec.id]: e.target.value })),
                  onKeyDown: (e) => { if (e.key === 'Enter') saveTags(rec); },
                }),
                h('button', {
                  className: '__lm2_btn',
                  disabled: busy || tagDraft[rec.id] === undefined,
                  onClick: () => saveTags(rec),
                }, '保存标签'),
              ),
            )),
          ),
      );
    }

    /* ════════════════════════════════════════════════════════════════════════
     * 七、外壳
     * ════════════════════════════════════════════════════════════════════════ */

    /**
     * 外壳：只留两件轻量事（列表、补标）+ 一个跳转。
     *
     * 关系图 / 卡片视图 / 右键看全文 / 联想 / 直觉 / 设置这些重交互**故意不在这里画**：
     * 它们只维护一份，放在独立应用里（点按钮会 302 过去，没启动就先拉起来）。
     * 两边各画一套的代价我们已经付过一次了——插件里那套永远落后。
     */
    function Panel() {
      const [tab, setTab] = useState('list');
      const openApp = () => {
        // 走宿主自己的 /open：它会确保独立应用在跑，再 302 过去
        window.open(API + '/open', '_blank', 'noopener');
      };
      return h('div', { className: '__lm2_root' },
        h('div', { className: '__lm2_bar' },
          h('button', {
            className: '__lm2_btn __lm2_btn--on',
            onClick: openApp,
            title: '在独立界面里看关系图、卡片视图、直觉和设置',
          }, '打开完整记忆界面'),
          h('span', { className: '__lm2_hint' }, '关系图 / 卡片视图 / 直觉 / 设置 都在独立界面里'),
        ),
        h('div', { className: '__lm2_tabs' },
          h('button', {
            className: '__lm2_tab' + (tab === 'list' ? ' __lm2_tab--on' : ''),
            onClick: () => setTab('list'),
          }, '记忆列表'),
          h('button', {
            className: '__lm2_tab' + (tab === 'classify' ? ' __lm2_tab--on' : ''),
            onClick: () => setTab('classify'),
          }, '补标'),
        ),
        tab === 'list' ? h(ListTab) : h(ClassifyTab),
      );
    }

    /**
     * 注册设置页分区。
     *
     * ⚠ 整个函数包在 try/catch 里是**故意的**，不是偷懒：
     * DSH 的前端 boot 只认 active，**一个客户端插件没激活，整页都不启动**。
     * v2.1.0 就因为浏览器半侧起不来，把一个装好的 DSH 拖成了白屏（同学机器实测）。
     * 客户端出错的正确代价是"这个页面没了"，绝不该是"整个应用开不了"。
     */
    function apply(ctx) {
      try {
        ensureStyle();
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'local-memory', order: 28, label: '本地记忆' },
          () => h(Panel),
        ));
      } catch (err) {
        try {
          console.error('[dsh-local-memory] 客户端注册失败（已忽略，不影响 DSH 启动）', err);
        } catch { /* console 都没了就算了 */ }
      }
    }

    exports.apply = apply;

    /** 只给单元测试与离线预览用：布局数学没有 DOM 依赖，必须能在 node 里直接测 */
    exports.__internals = {
      KIND_COLORS,
      CSS,
      OPEN_PATH: API + '/open',
      // 组件本身也给出去：离线预览用它渲染真组件，而不是照着重画一遍
      components: { Panel, ListTab, ClassifyTab },
    };

    return module.exports;
  },
});
