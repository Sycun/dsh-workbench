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
  return function Panel({ initialSnapshot, initialTaskId = '', initialScreen = 'chat', initialSettingsTab = 'projects' } = {}) {
    const [data, setData] = useState(initialSnapshot || { projects: [], tasks: [], events: [] });
    const [screen, setScreen] = useState(initialScreen), [tab, setTab] = useState(initialSettingsTab);
    const [selected, setSelected] = useState(initialTaskId), [projectId, setProjectId] = useState(''), [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [projectName, setProjectName] = useState(''), [cwd, setCwd] = useState(''), [directoryMode, setDirectoryMode] = useState('existing'), [folderName, setFolderName] = useState('');
    const [projectNameEdited, setProjectNameEdited] = useState(false);
    const setProjectDirectory = value => { setCwd(value); if (!projectNameEdited) { const clean = value.trim().replace(/[\\/]+$/, ''); setProjectName(/^[A-Za-z]:$/.test(clean) ? '' : clean.split(/[\\/]/).pop() || ''); } };
    const editProjectName = value => { setProjectName(value); setProjectNameEdited(Boolean(value.trim())); };
    const [logins, setLogins] = useState({}), [answers, setAnswers] = useState({}), [reconciliations, setReconciliations] = useState({});
    const [projectView, setProjectView] = useState('active'), [projectAction, setProjectAction] = useState(null), [historyProjectId, setHistoryProjectId] = useState('');
    const [connectionEditor, setConnectionEditor] = useState({ id: '', label: '', adapter: 'http-json', baseUrl: '', enabled: true, authType: 'none', tokenRef: '', healthPath: '', statusPath: '', submitPath: '', runStatusPath: '', runIdField: 'runId' });
    const [bodyDraft, setBodyDraft] = useState(JSON.stringify({ projectId: '{projectId}', taskId: '{taskId}', message: '{message}', idempotencyKey: '{idempotencyKey}' }, null, 2));
    const [connectionToken, setConnectionToken] = useState('');
    const editConnection = patch => setConnectionEditor(current => ({ ...current, ...patch }));
    const [linkKind, setLinkKind] = useState(''), [externalId, setExternalId] = useState(''), [scope, setScope] = useState(''), [grantKind, setGrantKind] = useState('');
    useEffect(() => { setExternalId(data.projects.find(p => p.id === projectId)?.integrations?.[linkKind]?.externalId || ''); }, [projectId, linkKind]);
    const task = data.tasks.find(t => t.id === selected);
    const isActiveProject = p => !p?.lifecycle || p.lifecycle === 'active';
    const taskProjectActive = !task || isActiveProject(data.projects.find(p => p.id === task.projectId));
    useEffect(() => { if (projectId && !isActiveProject(data.projects.find(p => p.id === projectId))) setProjectId(''); }, [data.projects, projectId]);
    const refresh = async () => { const next = await api(); setData(next); return next; };
    useEffect(() => { let active = true; const poll = () => api().then(value => { if (active) setData(value); }).catch(e => { if (active) setError(e.message); }); poll(); const timer = setInterval(poll, 5000); return () => { active = false; clearInterval(timer); }; }, []);
    const act = fn => async () => { setBusy(true); setError(''); setNotice(''); try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
    const button = (label, fn, primary = false, disabled = false) => h('button', { type: 'button', style: primary ? s.primary : s.button, disabled: busy || disabled, onClick: act(fn) }, label);
    const input = (label, value, set, type = 'text', props = {}) => h('input', { 'aria-label': label, placeholder: label, type, value, onChange: e => set(e.target.value), style: { ...s.input, flex: 1, minWidth: 180 }, ...props });
    const projectSelect = (label = '选择项目') => h('select', { 'aria-label': label, style: s.input, value: projectId, onChange: e => setProjectId(e.target.value) }, h('option', { value: '' }, '默认工作区（不指定项目）'), ...data.projects.filter(isActiveProject).map(p => h('option', { key: p.id, value: p.id }, p.name)));
    const kindSelect = (value, set, label) => h('select', { 'aria-label': label, style: s.input, value, onChange: e => set(e.target.value) }, h('option', { value: '' }, '选择执行端'), ...(data.connections || []).filter(c => c.enabled).map(c => h('option', { key: c.id, value: c.id }, c.label)));
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
    const connectionsForm = () => h(React.Fragment, null,
      h('section', { style: s.card }, h('h2', null, '我的工具与平台'),
        h('p', { style: s.muted }, '首次安装没有预设连接。DSH 已启用的工具和 MCP 按员工会话的权限直接复用；下面可添加自己的 HTTP/JSON 服务。'),
        (data.connections || []).length === 0 && h('p', null, '还没有外部连接，请填写下方表单添加。'),
        ...(data.connections || []).map(c => h('div', { key: c.id, style: { padding: '12px 0', borderTop: '1px solid #8a94a833' } },
          h('div', { style: s.row }, h('strong', null, c.label), h('span', { style: s.muted }, c.id + ' · ' + c.adapter + ' · ' + (c.enabled ? '已启用' : '已禁用')),
            c.editable && button('编辑', async () => { const { transport, bodyTemplate, ...config } = c.config; setConnectionEditor(config); setBodyDraft(JSON.stringify(bodyTemplate || {}, null, 2)); setConnectionToken(''); }),
            c.transport !== 'kali' && button('测试连接', async () => { const result = await api({ action: 'connection_probe', connector: c.id }); setNotice(result.message); })),
          c.health && h('p', { style: s.muted }, c.health.message), !c.editable && h('small', { style: s.muted }, '由本机 DSH 配置管理，配置不会包含在仓库发布包中。')))),
      h('section', { style: s.card }, h('h2', null, '添加 / 编辑连接'),
        h('div', { style: s.row }, input('连接 ID，例如 my-tool', connectionEditor.id, value => editConnection({ id: value })), input('显示名称', connectionEditor.label, value => editConnection({ label: value })),
          h('select', { 'aria-label': '接入类型', style: s.input, value: connectionEditor.adapter, onChange: e => editConnection({ adapter: e.target.value }) }, h('option', { value: 'http-json' }, '自定义 HTTP/JSON'), h('option', { value: 'artex' }, 'ARTEX API'), h('option', { value: 'cyberstrikeai' }, 'CyberStrikeAI API'))),
        h('div', { style: { ...s.row, marginTop: 12 } }, input('服务地址（不含路径）', connectionEditor.baseUrl, value => editConnection({ baseUrl: value })), h('label', null, h('input', { type: 'checkbox', checked: connectionEditor.enabled, onChange: e => editConnection({ enabled: e.target.checked }) }), '启用连接')),
        h('div', { style: { ...s.row, marginTop: 12 } }, h('select', { 'aria-label': '认证方式', style: s.input, value: connectionEditor.authType, onChange: e => editConnection({ authType: e.target.value }) }, h('option', { value: 'none' }, '无需认证'), h('option', { value: 'bearer' }, 'Bearer 令牌')), connectionEditor.authType === 'bearer' && input('凭据引用名，例如 MY_TOOL_TOKEN', connectionEditor.tokenRef, value => editConnection({ tokenRef: value })), connectionEditor.authType === 'bearer' && input('令牌（留空则复用已有凭据）', connectionToken, setConnectionToken, 'password')),
        h('div', { style: { ...s.row, marginTop: 12 } }, input('只读连接测试路径（可选）', connectionEditor.healthPath, value => editConnection({ healthPath: value }))),
        connectionEditor.adapter === 'http-json' && h(React.Fragment, null,
          h('div', { style: { ...s.row, marginTop: 12 } }, input('GET 项目状态路径', connectionEditor.statusPath, value => editConnection({ statusPath: value })), input('POST 提交任务路径', connectionEditor.submitPath, value => editConnection({ submitPath: value }))),
          h('p', { style: s.muted }, '路径支持 {projectId} / {taskId}；请求模板支持 {message} / {projectId} / {taskId} / {idempotencyKey}。只做字符串替换，不执行脚本。'),
          h('details', null, h('summary', null, '请求模板与任务状态接口'),
            h('textarea', { 'aria-label': 'JSON 请求模板', rows: 6, value: bodyDraft, onChange: e => setBodyDraft(e.target.value), style: { ...s.input, width: '100%', marginTop: 10, fontFamily: 'monospace' } }),
            h('div', { style: { ...s.row, marginTop: 10 } }, input('GET 执行状态路径（可选，支持 {runId}）', connectionEditor.runStatusPath, value => editConnection({ runStatusPath: value })), input('回执中的任务 ID 字段', connectionEditor.runIdField, value => editConnection({ runIdField: value }))))),
        h('p', { style: s.muted }, '连接设置留在本机。令牌单独写入 DSH 凭据存储，不随连接配置保存；修改连接后需重新设置任务执行范围。'),
        button('保存连接', async () => { const config = { ...connectionEditor }; if (config.adapter === 'http-json') { try { config.bodyTemplate = JSON.parse(bodyDraft); } catch { throw new Error('请求模板不是有效 JSON'); } } await api({ action: 'connection_save', config }); if (config.authType === 'bearer' && connectionToken) { await api({ action: 'connection_token', connector: config.id, token: connectionToken }); setConnectionToken(''); } setNotice('连接已保存，可在下方关联到项目。'); }, true, !connectionEditor.id.trim() || !connectionEditor.baseUrl.trim())));
    const settings = () => h('div', { style: { maxWidth: 1000, margin: '24px auto' } },
      h('div', { style: { ...s.row, marginBottom: 18 } }, ...[['projects', '项目与目录'], ['platforms', '工具接入'], ['task', '当前任务设置']].map(([key, label]) => button(label, async () => setTab(key), key === tab))),
      tab === 'projects' && h('section', { style: s.card }, h('h2', null, '添加项目'),
        h('div', { style: s.row }, h('select', { 'aria-label': '项目文件夹方式', value: directoryMode, onChange: e => setDirectoryMode(e.target.value), style: s.input }, h('option', { value: 'existing' }, '使用已有文件夹'), h('option', { value: 'create' }, '在指定路径新建文件夹')), input('项目名称', projectName, editProjectName)),
        h('div', { style: { ...s.row, marginTop: 12 } }, input('项目绝对路径', cwd, setCwd, 'text', { onBlur: () => setProjectDirectory(cwd) }), button('选择文件夹', async () => { const value = await ctx.uiWorkspace.pickDirectory(); if (value) setProjectDirectory(value); })),
        directoryMode === 'create' && h('div', { style: { ...s.row, marginTop: 12 } }, input('新文件夹名称', folderName, setFolderName), button('拼接到路径', async () => { if (!folderName.trim() || /[\\/]/.test(folderName) || ['.', '..'].includes(folderName.trim())) throw new Error('请输入单个文件夹名称'); setProjectDirectory(cwd.replace(/[\\/]$/, '') + '/' + folderName.trim()); setFolderName(''); })),
        h('p', { style: s.muted }, directoryMode === 'create' ? '在填写的完整路径创建空文件夹，上级目录须已存在；同名文件夹不会覆盖。' : '绑定现有目录，保留原有文件；员工会话与项目记忆以此目录为准。'),
        button(directoryMode === 'create' ? '创建文件夹并添加项目' : '绑定文件夹', async () => { const p = await api({ action: 'project', name: projectName, cwd, mode: directoryMode }); setProjectId(p.id); setProjectName(''); setProjectNameEdited(false); setCwd(''); await refresh(); const linked = await rpc(ctx.remote.workspace.create({ path: p.cwd })); await api({ action: 'workspace', projectId: p.id, workspaceId: linked.workspace.workspaceId }); setNotice('已关联 DSH 工作区：' + p.cwd); }, true, !cwd.trim()),
        h('h3', null, '项目管理'),
        h('div', { style: { ...s.row, marginBottom: 12 } }, ...[['active', '使用中'], ['archived', '已归档'], ['deleted', '回收站']].map(([value, label]) => button(label, async () => setProjectView(value), projectView === value))),
        projectAction && h('section', { style: { ...s.card, borderColor: '#cda552' } },
          h('strong', null, (projectAction.action === 'archive' ? '归档整个项目' : projectAction.action === 'delete' ? '删除项目登记（可恢复）' : '恢复整个项目') + '：' + projectAction.name),
          h('p', { style: s.text }, '原路径：' + projectAction.path),
          h('p', { style: s.muted }, `${projectAction.sessionCount} 个 DSH 会话，${projectAction.taskCount} 个工作台任务。磁盘文件保留在原路径。归档/删除会收起 DSH 工作区登记；远端平台任务不受此操作控制。活动会话会阻止操作。`),
          h('div', { style: s.row }, button('确认' + (projectAction.action === 'archive' ? '归档' : projectAction.action === 'delete' ? '删除' : '恢复'), async () => { await api({ action: 'project_lifecycle', projectId: projectAction.projectId, operation: projectAction.action }); setNotice('项目与 DSH 同步完成，文件保留在原路径。'); setProjectAction(null); }, true), button('取消', async () => setProjectAction(null)))),
        ...data.projects.filter(p => projectView === 'active' ? isActiveProject(p) || ['sync-error', 'archiving', 'deleting', 'restoring'].includes(p.lifecycle) : p.lifecycle === projectView).map(p => h('div', { key: p.id, style: { padding: '12px 0', borderTop: '1px solid #8a94a833' } },
          h('strong', null, p.name), h('div', { style: { ...s.muted, overflowWrap: 'anywhere' } }, p.cwd),
          p.lifecycleError && h('p', { style: { color: '#bf3434' } }, p.lifecycleError),
          h('div', { style: { ...s.row, marginTop: 8 } },
            button('查看任务', async () => { setHistoryProjectId(p.id); setScreen('history'); }),
            isActiveProject(p) && button('归档', async () => setProjectAction(await api({ action: 'project_preview', projectId: p.id, operation: 'archive' }))),
            p.lifecycle !== 'deleted' && button('删除', async () => setProjectAction(await api({ action: 'project_preview', projectId: p.id, operation: 'delete' }))),
            !isActiveProject(p) && button('恢复', async () => setProjectAction(await api({ action: 'project_preview', projectId: p.id, operation: 'restore' }))),
            p.lifecycle === 'sync-error' && p.nativeArchive?.action && button('重试同步', async () => setProjectAction(await api({ action: 'project_preview', projectId: p.id, operation: p.nativeArchive.action }))))))),
      tab === 'platforms' && h(React.Fragment, null,
        connectionsForm(),
        data.kali && h(React.Fragment, null,
        h('div', { style: { ...s.row, marginBottom: 15 } }, h('span', { style: s.muted }, data.kali.vm === 'running' ? 'Kali 已运行 · 自动检查服务与登录状态' : data.kali.error || '正在检查 Kali…'), button('检查连接', () => api({ action: 'platform_refresh' }))),
        h('div', { style: s.row }, ...['artex', 'cyberstrikeai'].map(kind => {
          const state = data.kali.platforms?.find(p => p.id === kind), name = kind === 'artex' ? 'ARTEX' : 'CyberStrikeAI';
          const login = logins[kind] || { username: kind === 'artex' ? 'ARTEX' : 'admin', password: '' };
          const setLogin = patch => setLogins(old => ({ ...old, [kind]: { ...login, ...patch } }));
          return h('section', { key: kind, style: { ...s.card, flex: 1, minWidth: 260 } }, h('h2', null, name), h('p', null, state?.authenticated ? '已连接 · 登录有效' : state?.reachable ? '服务在线 · 待登录' : '服务未连接'), h('p', { style: s.muted }, state?.autostart ? '已启用 Kali 开机启动' : '等待检查自启动状态'),
            h('details', { open: Boolean(state?.reachable && !state?.authenticated) }, h('summary', null, state?.authenticated ? '重新登录' : '使用现有账号连接'), h('div', { style: { ...s.row, marginTop: 12 } }, input(kind + ' 用户名', login.username, value => setLogin({ username: value })), input(kind + ' 密码', login.password, value => setLogin({ password: value }), 'password')), h('div', { style: { marginTop: 12 } }, button('登录 ' + name, async () => { const result = await api({ action: 'platform_login', connector: kind, ...login }); setLogin({ password: '' }); await api({ action: 'platform_refresh' }); setNotice(result.message); }, true, !login.password || !state?.reachable))));
        })),
        ),
        h('section', { style: s.card }, h('h2', null, '关联远端任务 / 项目'), h('p', { style: s.muted }, '选择工作台项目和已配置的执行端，填写该工具使用的项目或任务标识。关联只记录任务归属，不同步文件。'), h('div', { style: s.row }, projectSelect('待绑定项目'), kindSelect(linkKind, setLinkKind, '绑定执行端'), input('远端任务 / 项目 ID', externalId, setExternalId), button('保存关联', async () => { await api({ action: 'link_project', projectId, connector: linkKind, externalId }); setNotice('关联已保存。'); }, true, !projectId || !linkKind || !externalId.trim())), projectId && h('p', { style: s.muted }, data.projects.find(p => p.id === projectId)?.cwd))
        ,projectId && h('div', { style: s.card }, h('strong', null, '当前项目的关联'), ...Object.entries(data.projects.find(p => p.id === projectId)?.integrations || {}).map(([id, value]) => h('p', { key: id, style: s.muted }, ((data.connections || []).find(c => c.id === id)?.label || id) + ' → ' + value.externalId)))
      ),
      tab === 'task' && (task ? h('section', { style: s.card }, h('h2', null, '当前任务设置'), h('p', { style: s.text }, task.brief), h('p', { style: s.muted }, '先完成远端项目关联。填写本次允许员工执行的具体范围，有效期为 24 小时。'), h('div', { style: s.row }, kindSelect(grantKind, setGrantKind, '授权执行端'), input('本次执行范围', scope, setScope), button('保存本次执行范围', () => api({ action: 'authorize', taskId: task.id, connector: grantKind, scope, expiresAt: new Date(Date.now() + 86400000).toISOString() }), true, !taskProjectActive || !grantKind || !scope.trim())), ...Object.entries(task.authorizations || {}).map(([kind, grant]) => h('p', { key: kind, style: s.muted }, kind + '：' + grant.scope + ' · 到期 ' + new Date(grant.expiresAt).toLocaleString())), h('small', { style: s.muted }, '任务 ID：' + task.id)) : h('p', null, '先从对话或历史中选择任务。')));
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
      task.summary && h('div', { style: s.bubble }, h('strong', null, '交付摘要'), h('p', { style: s.text }, task.summary), taskProjectActive && task.status === 'review' && button('验收通过', () => api({ action: 'accept', taskId: task.id }), true)));
    return h('div', { style: s.page },
      h('header', { style: { ...s.row, justifyContent: 'space-between' } }, h('strong', { style: { fontSize: 18 } }, screen === 'settings' ? '工作台设置' : screen === 'history' ? '历史任务' : '项目工作台'),
        h('nav', { style: s.row }, screen !== 'chat' && button('返回对话', async () => setScreen('chat')), button('新对话', async () => { setSelected(''); setDraft(''); setScreen('chat'); }), button('历史', async () => { setHistoryProjectId(''); setScreen('history'); }), button('设置', async () => setScreen('settings')))),
      ...(data.projectWarnings || []).map(w => h('div', { key: w.projectId, role: 'status', style: { ...s.row, ...s.muted, padding: '10px 0', color: '#a56b19' } }, h('span', null, w.name + '：' + w.message), button('查看项目', async () => { setScreen('settings'); setTab('projects'); setProjectView('active'); }))),
      error && h('p', { role: 'alert', style: { color: '#bf3434', lineHeight: 1.6 } }, error), notice && h('p', { role: 'status', style: s.muted }, notice),
      screen === 'settings' ? settings() : screen === 'history' ? h('div', { style: { maxWidth: 960, margin: '24px auto' } }, data.tasks.length === 0 && h('p', { style: s.muted }, '还没有任务，开始一段新对话即可。'), ...[...data.tasks].filter(t => historyProjectId ? t.projectId === historyProjectId : isActiveProject(data.projects.find(p => p.id === t.projectId))).reverse().map(t => h('button', { key: t.id, style: { ...s.card, display: 'block', width: '100%', color: 'inherit', textAlign: 'left', cursor: 'pointer' }, onClick: () => { setSelected(t.id); setProjectId(t.projectId); setScreen('chat'); setDraft(''); } }, h('small', { style: s.muted }, (data.projects.find(p => p.id === t.projectId)?.name || '默认工作区') + ' · ' + labels[t.status]), h('p', { style: s.text }, t.brief.slice(0, 160))))) :
      h('main', { style: { maxWidth: 920, margin: task ? '26px auto' : 'min(20vh, 180px) auto 30px' } },
        !task && h('h1', { style: { fontSize: 28, fontWeight: 550, textAlign: 'center', marginBottom: 28 } }, '你想安排什么工作？'),
        task && h(React.Fragment, null, h('div', { style: { ...s.row, justifyContent: 'space-between' } }, h('span', { style: s.muted }, (data.projects.find(p => p.id === task.projectId)?.name || '默认工作区') + ' · ' + labels[task.status]), h('div', { style: s.row },
          task.sessionId && button('员工会话', async () => ctx.uiWorkspace.openSession(task.sessionId)),
          taskProjectActive && task.status === 'draft' && button('重试派工', () => launch(task)),
          taskProjectActive && ['running', 'waiting', 'draft'].includes(task.status) && button('暂停 DSH 员工', async () => { await api({ action: 'pause', taskId: task.id }); if (task.sessionId) await rpc(ctx.remote.session.cancel({ sessionId: task.sessionId })); setNotice('已暂停 DSH 当前轮。外部平台已接单的工作需要在平台停止并核实。'); }),
          taskProjectActive && task.status === 'paused' && button('恢复员工', async () => { const updated = await api({ action: 'resume', taskId: task.id }); if (task.sessionId) await send(task, `继续工作台任务 ${task.id}，先读取最新状态和决策。`, `${task.id}:resume:${updated.updatedAt}`); else await launch(updated); }))), messages()),
        h('div', { style: { ...s.card, boxShadow: '0 8px 30px #27314c06', marginTop: 24 } },
          h('textarea', { 'aria-label': '交办工作', placeholder: !task ? '描述想完成的工作，员工会整理计划并向你汇报…' : !taskProjectActive ? '项目已归档或移除，请先在设置中恢复项目。' : task.status === 'paused' ? '任务已暂停，恢复后可以继续对话。' : ['review', 'accepted'].includes(task.status) ? '本次工作已交付，可以验收或开始新对话。' : '补充要求，或直接回答员工的问题…', value: draft, onChange: e => setDraft(e.target.value), disabled: Boolean(!taskProjectActive || (task && ['paused', 'review', 'accepted'].includes(task.status))), rows: 4, style: { ...s.input, width: '100%', border: 0, resize: 'vertical', fontSize: 15, outline: 'none' } }),
          h('div', { style: { ...s.row, justifyContent: 'space-between', marginTop: 8 } }, task ? h('small', { style: s.muted }, labels[task.status]) : projectSelect(), button(task ? '发送' : '交给员工', submit, true, !draft.trim() || Boolean(!taskProjectActive || (task && ['paused', 'review', 'accepted'].includes(task.status))))))));
  };
}
