export function createPanel(React, ctx) {
  const h = React.createElement, { useEffect, useState } = React;
  const labels = { draft: '员工待接单', running: '执行中', waiting: '待你决定', paused: '已暂停', review: '待验收', accepted: '已验收' };
  async function api(action) {
    const res = await fetch('/api/dsh-workbench', action ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Workbench': '1' }, body: JSON.stringify(action) } : {});
    const value = await res.json(); if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`); return value;
  }
  async function rpc(promise) {
    const value = await promise;
    if (value?.ok === false) throw new Error(value.error?.message || value.error?.code || 'DSH 请求失败');
    return value?.ok === true ? value.value : value;
  }
  const s = {
    page: { padding: '22px 28px', height: '100%', boxSizing: 'border-box', overflow: 'auto', color: 'var(--foreground, #242935)', background: 'var(--background, #f6f7f9)', fontFamily: 'system-ui, sans-serif' },
    row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    card: { background: 'var(--background, white)', border: '1px solid #8a94a833', borderRadius: 14, padding: 20, marginBottom: 14 },
    input: { border: '1px solid #8a94a855', borderRadius: 9, padding: 10, background: 'transparent', color: 'inherit', boxSizing: 'border-box' },
    button: { border: '1px solid #8a94a844', borderRadius: 9, padding: '9px 14px', background: 'transparent', color: 'inherit', cursor: 'pointer' },
    primary: { border: 0, borderRadius: 9, padding: '10px 18px', background: '#275ce8', color: 'white', cursor: 'pointer' },
    muted: { color: '#798497', fontSize: 13, lineHeight: 1.6 },
    text: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7 },
    bubble: { margin: '18px 0', padding: '16px 20px', borderRadius: 14, border: '1px solid #8a94a833', lineHeight: 1.7 }
  };
  return function Panel({ initialSnapshot, initialTaskId = '' } = {}) {
    const [data, setData] = useState(initialSnapshot || { projects: [], tasks: [], events: [] });
    const [screen, setScreen] = useState('chat'), [tab, setTab] = useState('projects');
    const [selected, setSelected] = useState(initialTaskId), [projectId, setProjectId] = useState(''), [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [projectName, setProjectName] = useState(''), [cwd, setCwd] = useState(''), [directoryMode, setDirectoryMode] = useState('existing'), [folderName, setFolderName] = useState('');
    const [logins, setLogins] = useState({}), [answers, setAnswers] = useState({}), [reconciliations, setReconciliations] = useState({});
    const [linkKind, setLinkKind] = useState('artex'), [externalId, setExternalId] = useState(''), [scope, setScope] = useState(''), [grantKind, setGrantKind] = useState('artex');
    const task = data.tasks.find(t => t.id === selected);
    const refresh = async () => { const next = await api(); setData(next); return next; };
    useEffect(() => { let active = true; const poll = () => api().then(value => { if (active) setData(value); }).catch(e => { if (active) setError(e.message); }); poll(); const timer = setInterval(poll, 5000); return () => { active = false; clearInterval(timer); }; }, []);
    const act = fn => async () => { setBusy(true); setError(''); setNotice(''); try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
    const button = (label, fn, primary = false, disabled = false) => h('button', { type: 'button', style: primary ? s.primary : s.button, disabled: busy || disabled, onClick: act(fn) }, label);
    const input = (label, value, set, type = 'text') => h('input', { 'aria-label': label, placeholder: label, type, value, onChange: e => set(e.target.value), style: { ...s.input, flex: 1, minWidth: 180 } });
    const projectSelect = (label = '选择项目') => h('select', { 'aria-label': label, style: s.input, value: projectId, onChange: e => setProjectId(e.target.value) }, h('option', { value: '' }, '默认工作区（不指定项目）'), ...data.projects.map(p => h('option', { key: p.id, value: p.id }, p.name)));
    const kindSelect = (value, set, label) => h('select', { 'aria-label': label, style: s.input, value, onChange: e => set(e.target.value) }, h('option', { value: 'artex' }, 'ARTEX'), h('option', { value: 'cyberstrikeai' }, 'CyberStrikeAI'));
    const send = (t, text, requestId) => rpc(ctx.remote.session.prompt({ sessionId: t.sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    const launch = async t => {
      let current = t;
      if (!current.sessionId) {
        const state = await api(), project = state.projects.find(p => p.id === t.projectId);
        if (!project) throw new Error('项目记录不存在');
        const linked = await rpc(ctx.remote.workspace.create({ path: project.cwd }));
        await api({ action: 'workspace', projectId: project.id, workspaceId: linked.workspace.workspaceId });
        const created = await rpc(ctx.remote.session.create({ workspaceId: linked.workspace.workspaceId, sessionId: `session-${t.id}` }));
        current = await api({ action: 'bind', taskId: t.id, sessionId: created.sessionId });
      }
      const assignment = await api({ action: 'assignment', taskId: t.id });
      await send(current, assignment.prompt, current.requestId);
    };
    const deliver = async (t, q) => {
      await send(t, `老板已回答工作台决策 ${q.id}：${q.answer}\n请用 workbench_get 读取任务 ${t.id} 的最新状态并继续。`, q.deliveryId);
      await api({ action: 'delivered', taskId: t.id, questionId: q.id });
    };
    const answer = async (q, text) => { const saved = await api({ action: 'answer', taskId: task.id, questionId: q.id, answer: text }); if (task.status !== 'paused') await deliver(task, saved); };
    const submit = async () => {
      const text = draft.trim(); if (!text) return;
      if (!task) { const created = await api({ action: 'create', projectId, brief: text }); setSelected(created.id); setDraft(''); await launch(created); }
      else {
        const pending = task.questions.filter(q => !q.answer);
        if (pending.length === 1) await answer(pending[0], text);
        else { const message = await api({ action: 'message', taskId: task.id, text }); await send(task, text, message.id); await api({ action: 'message_delivered', taskId: task.id, messageId: message.id }); }
        setDraft('');
      }
    };
    const settings = () => h('div', { style: { maxWidth: 1000, margin: '24px auto' } },
      h('div', { style: { ...s.row, marginBottom: 18 } }, ...[['projects', '项目与目录'], ['platforms', 'Kali 连接'], ['task', '当前任务设置']].map(([key, label]) => button(label, async () => setTab(key), key === tab))),
      tab === 'projects' && h('section', { style: s.card }, h('h2', null, '添加项目'),
        h('div', { style: s.row }, h('select', { 'aria-label': '项目文件夹方式', value: directoryMode, onChange: e => setDirectoryMode(e.target.value), style: s.input }, h('option', { value: 'existing' }, '使用已有文件夹'), h('option', { value: 'create' }, '在指定路径新建文件夹')), input('项目名称', projectName, setProjectName)),
        h('div', { style: { ...s.row, marginTop: 12 } }, input('项目绝对路径', cwd, setCwd), button('选择文件夹', async () => { const value = await ctx.uiWorkspace.pickDirectory(); if (value) setCwd(value); })),
        directoryMode === 'create' && h('div', { style: { ...s.row, marginTop: 12 } }, input('新文件夹名称', folderName, setFolderName), button('拼接到路径', async () => { if (!folderName.trim() || /[\\/]/.test(folderName) || ['.', '..'].includes(folderName.trim())) throw new Error('请输入单个文件夹名称'); setCwd(cwd.replace(/[\\/]$/, '') + '/' + folderName.trim()); setFolderName(''); })),
        h('p', { style: s.muted }, directoryMode === 'create' ? '在填写的完整路径创建空文件夹，上级目录须已存在；同名文件夹不会覆盖。' : '绑定现有目录，保留原有文件；员工会话与项目记忆以此目录为准。'),
        button(directoryMode === 'create' ? '创建文件夹并添加项目' : '绑定文件夹', async () => { const p = await api({ action: 'project', name: projectName, cwd, mode: directoryMode }); setProjectId(p.id); setProjectName(''); setCwd(''); await refresh(); const linked = await rpc(ctx.remote.workspace.create({ path: p.cwd })); await api({ action: 'workspace', projectId: p.id, workspaceId: linked.workspace.workspaceId }); setNotice('已关联 DSH 工作区：' + p.cwd); }, true, !projectName.trim() || !cwd.trim()),
        h('h3', null, '已有项目'), ...data.projects.map(p => h('div', { key: p.id, style: { padding: '10px 0', borderTop: '1px solid #8a94a833' } }, h('strong', null, p.name), h('div', { style: { ...s.muted, overflowWrap: 'anywhere' } }, p.cwd)))),
      tab === 'platforms' && (data.kali ? h(React.Fragment, null,
        h('div', { style: { ...s.row, marginBottom: 15 } }, h('span', { style: s.muted }, data.kali.vm === 'running' ? 'Kali 已运行 · 自动检查服务与登录状态' : data.kali.error || '正在检查 Kali…'), button('检查连接', () => api({ action: 'platform_refresh' }))),
        h('div', { style: s.row }, ...['artex', 'cyberstrikeai'].map(kind => {
          const state = data.kali.platforms?.find(p => p.id === kind), name = kind === 'artex' ? 'ARTEX' : 'CyberStrikeAI';
          const login = logins[kind] || { username: kind === 'artex' ? 'ARTEX' : 'admin', password: '' };
          const setLogin = patch => setLogins(old => ({ ...old, [kind]: { ...login, ...patch } }));
          return h('section', { key: kind, style: { ...s.card, flex: 1, minWidth: 260 } }, h('h2', null, name), h('p', null, state?.authenticated ? '已连接 · 登录有效' : state?.reachable ? '服务在线 · 待登录' : '服务未连接'), h('p', { style: s.muted }, state?.autostart ? '已启用 Kali 开机启动' : '等待检查自启动状态'),
            h('details', { open: Boolean(state?.reachable && !state?.authenticated) }, h('summary', null, state?.authenticated ? '重新登录' : '使用现有账号连接'), h('div', { style: { ...s.row, marginTop: 12 } }, input(kind + ' 用户名', login.username, value => setLogin({ username: value })), input(kind + ' 密码', login.password, value => setLogin({ password: value }), 'password')), h('div', { style: { marginTop: 12 } }, button('登录 ' + name, async () => { const result = await api({ action: 'platform_login', connector: kind, ...login }); setLogin({ password: '' }); await api({ action: 'platform_refresh' }); setNotice(result.message); }, true, !login.password || !state?.reachable))));
        })),
        h('section', { style: s.card }, h('h2', null, '关联远端任务 / 项目'), h('p', { style: s.muted }, '把 Mac 工作台项目关联到已有的 ARTEX 任务或 CyberStrikeAI 项目。此操作只关联任务归属，不共享、挂载或同步文件夹。'), h('div', { style: s.row }, projectSelect('待绑定项目'), kindSelect(linkKind, setLinkKind, '绑定执行端'), input('远端任务 / 项目 ID', externalId, setExternalId), button('保存关联', async () => { await api({ action: 'link_project', projectId, connector: linkKind, externalId }); setNotice('关联已保存。'); }, true, !projectId || !externalId.trim())), projectId && h('p', { style: s.muted }, data.projects.find(p => p.id === projectId)?.cwd))
      ) : h('p', null, '此 DSH 配置尚未启用 Kali 连接。')),
      tab === 'task' && (task ? h('section', { style: s.card }, h('h2', null, '当前任务设置'), h('p', { style: s.text }, task.brief), h('p', { style: s.muted }, '先完成远端项目关联。填写本次允许员工执行的具体范围，有效期为 24 小时。'), h('div', { style: s.row }, kindSelect(grantKind, setGrantKind, '授权执行端'), input('本次执行范围', scope, setScope), button('保存本次执行范围', () => api({ action: 'authorize', taskId: task.id, connector: grantKind, scope, expiresAt: new Date(Date.now() + 86400000).toISOString() }), true, !scope.trim())), ...Object.entries(task.authorizations || {}).map(([kind, grant]) => h('p', { key: kind, style: s.muted }, kind + '：' + grant.scope + ' · 到期 ' + new Date(grant.expiresAt).toLocaleString())), h('small', { style: s.muted }, '任务 ID：' + task.id)) : h('p', null, '先从对话或历史中选择任务。')));
    const timeline = () => [
      ...task.reports.map((r, i)  => ({ at: r.at, node: h('div', { key: 'report-' + i, style: s.bubble }, h('small', { style: s.muted }, '员工 · 阶段汇报'), h('p', { style: s.text }, r.summary), r.remaining.length > 0 && h('p', { style: s.muted }, '待办：' + r.remaining.join('；')), h('details', null, h('summary', { style: s.muted }, '查看证据（员工提供，待核实）'), ...r.evidence.map((value, j) => h('p', { key: j, style: s.text }, value)))) })),
      ...(task.messages || []).map(m  => ({ at: m.at, node: h('div', { key: m.id, style: { ...s.bubble, background: '#6476a414', marginLeft: '8%' } }, h('small', { style: s.muted }, '你'), h('p', { style: s.text }, m.text), !m.delivered && button('重试发送', async () => { await send(task, m.text, m.id); await api({ action: 'message_delivered', taskId: task.id, messageId: m.id }); }, false, task.status === 'paused')) })),
      ...task.questions.map(q  => ({ at: q.createdAt, node: h('div', { key: q.id, style: { ...s.bubble, borderColor: q.answer ? '#8a94a833' : '#d5a44c' } }, h('strong', null, q.answer ? '已决策' : '需要你决定'), h('p', null, q.question), h('p', { style: s.muted }, q.reason), h('p', null, '员工建议：' + q.recommendation), q.answer ? h('p', { style: s.text }, q.answer, !q.delivered && button('重试投递答复', () => deliver(task, q), false, task.status === 'paused')) : h(React.Fragment, null, h('div', { style: s.row }, ...q.options.map(option => button(option, () => answer(q, option)))), h('div', { style: { ...s.row, marginTop: 10 } }, input('补充答复', answers[q.id] || '', value => setAnswers(a => ({ ...a, [q.id]: value }))), button('答复员工', () => answer(q, answers[q.id]), false, !answers[q.id]?.trim())))) })),
      ...task.runs.map(r  => ({ at: r.at, node: h('details', { key: r.id, style: s.card }, h('summary', null, r.connector + ' · ' + r.status), h('pre', { style: s.text }, JSON.stringify(r.receipt || {}, null, 2)), ['submitting', 'accepted', 'unknown'].includes(r.status) && h(React.Fragment, null, input('远端核实证据', reconciliations[r.id] || '', value => setReconciliations(a => ({ ...a, [r.id]: value }))), h('div', { style: { ...s.row, marginTop: 10 } }, ...[['completed', '已完成'], ['failed', '失败'], ['cancelled', '已取消']].map(([outcome, label]) => button('核实为' + label, () => api({ action: 'reconcile', taskId: task.id, runId: r.id, outcome, evidence: reconciliations[r.id] }), false, !reconciliations[r.id]?.trim()))))) })),
    ].sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0)).map(item => item.node);
    const messages = () => h(React.Fragment, null,
      h('div', { style: { ...s.bubble, background: '#6476a414', marginLeft: '8%' } }, h('small', { style: s.muted }, '你'), h('div', { style: s.text }, task.brief)),
      task.plan && h('details', { style: { ...s.card, padding: '12px 16px' } }, h('summary', null, `工作计划 · ${task.plan.stages.filter(p => p.status === 'done').length}/${task.plan.stages.length} 阶段`), h('p', null, task.plan.objective), ...task.plan.stages.map(st => h('p', { key: st.id }, (st.status === 'done' ? '✓ ' : '○ ') + st.title, h('small', { style: { ...s.muted, display: 'block' } }, st.acceptance)))),
      ...timeline(),
      task.summary && h('div', { style: s.bubble }, h('strong', null, '交付摘要'), h('p', { style: s.text }, task.summary), task.status === 'review' && button('验收通过', () => api({ action: 'accept', taskId: task.id }), true)));
    return h('div', { style: s.page },
      h('header', { style: { ...s.row, justifyContent: 'space-between' } }, h('strong', { style: { fontSize: 18 } }, screen === 'settings' ? '工作台设置' : screen === 'history' ? '历史任务' : '项目工作台'),
        h('nav', { style: s.row }, screen !== 'chat' && button('返回对话', async () => setScreen('chat')), button('新对话', async () => { setSelected(''); setDraft(''); setScreen('chat'); }), button('历史', async () => setScreen('history')), button('设置', async () => setScreen('settings')))),
      error && h('p', { role: 'alert', style: { color: '#bf3434', lineHeight: 1.6 } }, error), notice && h('p', { role: 'status', style: s.muted }, notice),
      screen === 'settings' ? settings() : screen === 'history' ? h('div', { style: { maxWidth: 960, margin: '24px auto' } }, data.tasks.length === 0 && h('p', { style: s.muted }, '还没有任务，开始一段新对话即可。'), ...[...data.tasks].reverse().map(t => h('button', { key: t.id, style: { ...s.card, display: 'block', width: '100%', color: 'inherit', textAlign: 'left', cursor: 'pointer' }, onClick: () => { setSelected(t.id); setProjectId(t.projectId); setScreen('chat'); setDraft(''); } }, h('small', { style: s.muted }, (data.projects.find(p => p.id === t.projectId)?.name || '默认工作区') + ' · ' + labels[t.status]), h('p', { style: s.text }, t.brief.slice(0, 160))))) :
      h('main', { style: { maxWidth: 920, margin: task ? '26px auto' : 'min(20vh, 180px) auto 30px' } },
        !task && h('h1', { style: { fontSize: 28, fontWeight: 550, textAlign: 'center', marginBottom: 28 } }, '你想安排什么工作？'),
        task && h(React.Fragment, null, h('div', { style: { ...s.row, justifyContent: 'space-between' } }, h('span', { style: s.muted }, (data.projects.find(p => p.id === task.projectId)?.name || '默认工作区') + ' · ' + labels[task.status]), h('div', { style: s.row },
          task.sessionId && button('员工会话', async () => ctx.uiWorkspace.openSession(task.sessionId)),
          task.status === 'draft' && button('重试派工', () => launch(task)),
          ['running', 'waiting', 'draft'].includes(task.status) && button('暂停 DSH 员工', async () => { await api({ action: 'pause', taskId: task.id }); if (task.sessionId) await rpc(ctx.remote.session.cancel({ sessionId: task.sessionId })); setNotice('已暂停 DSH 当前轮。外部平台已接单的工作需要在平台停止并核实。'); }),
          task.status === 'paused' && button('恢复员工', async () => { const updated = await api({ action: 'resume', taskId: task.id }); if (task.sessionId) await send(task, `继续工作台任务 ${task.id}，先读取最新状态和决策。`, `${task.id}:resume:${updated.updatedAt}`); else await launch(updated); }))), messages()),
        h('div', { style: { ...s.card, boxShadow: '0 8px 30px #27314c06', marginTop: 24 } },
          h('textarea', { 'aria-label': '交办工作', placeholder: !task ? '描述想完成的工作，员工会整理计划并向你汇报…' : task.status === 'paused' ? '任务已暂停，恢复后可以继续对话。' : ['review', 'accepted'].includes(task.status) ? '本次工作已交付，可以验收或开始新对话。' : '补充要求，或直接回答员工的问题…', value: draft, onChange: e => setDraft(e.target.value), disabled: Boolean(task && ['paused', 'review', 'accepted'].includes(task.status)), rows: 4, style: { ...s.input, width: '100%', border: 0, resize: 'vertical', fontSize: 15, outline: 'none' } }),
          h('div', { style: { ...s.row, justifyContent: 'space-between', marginTop: 8 } }, task ? h('small', { style: s.muted }, labels[task.status]) : projectSelect(), button(task ? '发送' : '交给员工', submit, true, !draft.trim() || Boolean(task && ['paused', 'review', 'accepted'].includes(task.status)))))));
  };
}
