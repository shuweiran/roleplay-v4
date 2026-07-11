import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { api } from '../../api/client';

type Scene = any;
type Character = any;

const WEREWOLF_DEFAULTS = ['苏哲', '林诗', '老王', '小美', '阿强'];

export function ScenePage() {
  const store = useAppStore();
  const {
    characters, scenes, mode,
    currentPlayer, roomCode, onlinePlayers,
    goToView, goChat, enterScene,
    setMode, loadState, loadHistory,
  } = store;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeScene, setActiveScene] = useState<Scene | null>(null);
  const [status, setStatus] = useState('');
  const [rulesTab, setRulesTab] = useState<'ww' | 'script'>('ww');
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(false);

  const [modalType, setModalType] = useState<'char' | 'scene' | null>(null);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [formName, setFormName] = useState('');
  const [formVoice, setFormVoice] = useState('');
  const [formPersona, setFormPersona] = useState('');
  const [formBg, setFormBg] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formKeyword, setFormKeyword] = useState('');
  const [scriptPrompt, setScriptPrompt] = useState('');
  const [scriptJson, setScriptJson] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [roleConfig, setRoleConfig] = useState<Record<string, number>>({
    wolf: 1, seer: 1, witch: 1, hunter: 0, villager: 2,
  });

  const selectedNames = Array.from(selected);
  const roomPlayers = Array.from(new Set(onlinePlayers.filter(Boolean)));
  const isRulesMode = mode === 'rules';

  // Auto-select default werewolf characters when entering rules+ww mode
  useEffect(() => {
    if (!isRulesMode || rulesTab !== 'ww') return;
    if (characters.length === 0) return;
    const available = new Set(characters.map(c => c.name));
    setSelected(prev => {
      const n = new Set(prev);
      WEREWOLF_DEFAULTS.forEach(d => {
        if (available.has(d)) n.add(d);
      });
      return n;
    });
  }, [isRulesMode, rulesTab, characters.length]);

  const toggleCharacter = (name: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  };

  const selectScene = (scene: Scene) => { setActiveScene(scene); };

  const openNewChar = () => { setModalType('char'); setEditTarget(null); setFormName(''); setFormVoice(''); setFormPersona(''); setFormBg(''); };
  const openEditChar = (ch: Character) => { setModalType('char'); setEditTarget(ch); setFormName(ch.name); setFormVoice(ch.voice); setFormPersona(ch.persona); setFormBg(ch.background); };
  const openNewScene = () => { setModalType('scene'); setEditTarget(null); setFormName(''); setFormDesc(''); };
  const openEditScene = (sc: Scene) => { setModalType('scene'); setEditTarget(sc); setFormName(sc.name); setFormDesc(sc.description); };
  const closeModal = () => setModalType(null);

  const saveChar = async () => {
    if (!formName) return;
    setLoading(true);
    try {
      if (editTarget) {
        await api.updateCharacter(editTarget.name, { name: formName, persona: formPersona, voice: formVoice, background: formBg });
      } else {
        await api.createCharacter({ name: formName, persona: formPersona, voice: formVoice, background: formBg });
      }
      closeModal();
      await loadState();
    } catch (e: any) { setStatus(e.message); }
    setLoading(false);
  };

  const saveScene = async () => {
    if (!formName || !formDesc) return;
    setLoading(true);
    try {
      if (editTarget) {
        await api.updateScene(editTarget.scene_id, { name: formName, description: formDesc });
      } else {
        await api.createScene({ name: formName, description: formDesc, initial_agent_names: [] });
      }
      closeModal();
      await loadState();
    } catch (e: any) { setStatus(e.message); }
    setLoading(false);
  };

  const deleteScene = async (sc: Scene) => {
    try { await api.deleteScene(sc.scene_id); await loadState(); } catch (e: any) { setStatus(e.message); }
  };

  const generateChar = async () => {
    if (!formKeyword) return;
    setGenerating(true);
    try { await api.generateCharacter(formKeyword); await loadState(); closeModal(); } catch (e: any) { setStatus(e.message); }
    setGenerating(false);
  };

  const generateScene = async () => {
    if (!formKeyword) return;
    setGenerating(true);
    try { await api.generateScene(formKeyword); await loadState(); closeModal(); } catch (e: any) { setStatus(e.message); }
    setGenerating(false);
  };

  // Free mode: enter scene with characters
  const start = async () => {
    if (!activeScene) { setStatus('请先选择一个场景'); return; }
    if (selectedNames.length === 0) { setStatus('请先选择角色'); return; }
    setStatus('正在进入场景...');
    try {
      const humanPlayers = roomPlayers;
      const scenePlayers = Array.from(new Set([...selectedNames, ...humanPlayers]));
      await enterScene(activeScene.scene_id, scenePlayers);
      if (mode === 'werewolf') {
        setStatus('正在初始化狼人杀...');
        await setMode('werewolf', '', currentPlayer);
        const initData = await api.werewolfInit(currentPlayer, humanPlayers);
        const roleData = await api.werewolfStatus(currentPlayer);
        const cnMap: Record<string, string> = {
          wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', villager: '村民',
        };
        setStatus('你的身份：' + (cnMap[roleData.your_role] || roleData.your_role || '未知') + ' | 存活 ' + roleData.alive_players.length + ' 人 | 共 ' + initData.player_count + ' 人');
      }
    } catch (e: any) { setStatus(e.message || '进入失败'); }
  };

  // Rules mode: werewolf start
  const startWWGame = async () => {
    const names = Array.from(selected);
    if (names.length < 5) { setStatus('至少需要5个角色，当前已选' + names.length + '个'); return; }
    setStatus('正在进入狼人杀...');
    try {
      await enterScene('werewolf_default', names);
      const humanPlayers = roomPlayers;
      await setMode('werewolf', '', currentPlayer);
      // Pass role config as query params: &wolf=2&seer=1...
      const roleParams = Object.entries(roleConfig).filter(([_,v]) => v > 0).map(([k,v]) => `${k}=${v}`).join('&');
      await fetch(`/api/werewolf/init?player_name=${encodeURIComponent(currentPlayer)}&human_players=${encodeURIComponent(humanPlayers.join(','))}&${roleParams}`, { method: 'POST' });
      await loadHistory();
      const roleData = await api.werewolfStatus(currentPlayer);
      const roleMap: Record<string, string> = { wolf:'狼人', seer:'预言家', witch:'女巫', hunter:'猎人', villager:'村民' };
      const phaseMap: Record<string, string> = { night:'夜晚', discussion:'讨论', voting:'投票' };
      setStatus('你的身份：' + (roleMap[roleData.your_role] || roleData.your_role || '未知') +
        ' | 存活 ' + (roleData.alive_players || []).length + ' | 阶段：' + (phaseMap[roleData.phase] || roleData.phase));
    } catch (e: any) { setStatus(e.message || '进入失败'); }
  };

  // Script generation
  const genScript = async () => {
    if (!scriptPrompt) return;
    setGenerating(true);
    try {
      const r = await api.generateScript(scriptPrompt, Math.max(2, selectedNames.length));
      if (r.script_data) setScriptJson(JSON.stringify(r.script_data, null, 2));
      setStatus('剧本已生成');
    } catch (e: any) { setStatus(e.message); }
    setGenerating(false);
  };

  const startScript = async () => {
    if (!scriptJson) { setStatus('请先生成剧本'); return; }
    setLoading(true);
    try {
      const scriptData = JSON.parse(scriptJson);
      const charNames: string[] = (scriptData.characters || []).map((c: any) => c.name);
      const humanPlayers = roomPlayers;
      await store.assignRoomCharacters(charNames);
      await api.loadScript({ script_data: scriptData, human_players: humanPlayers });
      await setMode('script');
      await loadHistory();
      goChat();
    } catch (e: any) { setStatus(e.message); }
    setLoading(false);
  };

  const shortText = (t: string, n: number) => (t || '').length > n ? (t || '').slice(0, n) + '...' : (t || '');

  const createDefaults = async () => {
    setLoading(true);
    const available = new Set(characters.map(c => c.name));
    const toCreate = WEREWOLF_DEFAULTS.filter(d => !available.has(d));
    for (const name of toCreate) {
      try { await api.createCharacter({ name, persona: name + '，普通角色', voice: '正常说话', background: '未知' }); } catch {}
    }
    await loadState();
    setLoading(false);
  };

  const missingDefaults = WEREWOLF_DEFAULTS.filter(d => !new Set(characters.map(c => c.name)).has(d));

  return (
    <div className="setup-page">
      <div className="panel" style={{ width: 900, border: 0, borderRadius: 12, padding: 32 }}>
        <div className="section-row" style={{ marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>{isRulesMode ? '规则模式' : '场景设置'}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="status-pill">角色 {characters.length}</span>
            {!isRulesMode && <span className="status-pill">场景 {scenes.length}</span>}
            <button className="btn" onClick={() => goToView('config')}>素材库</button>
          </div>
        </div>

        {/* ===== Character Selection (shared) ===== */}
        <section className="panel" style={{ border: 0, borderRadius: 8 }}>
          <div className="panel-body">
            <div className="section" style={{ marginBottom: 12 }}>
              <div className="section-row" style={{ marginBottom: 12 }}>
                <div className="label" style={{ fontSize: 15, fontWeight: 600 }}>角色</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-small" onClick={() => setSelected(new Set(characters.map(c => c.name)))}>全选</button>
                  <button className="btn btn-small" onClick={() => setSelected(new Set())}>清空</button>
                  <button className="btn btn-small btn-primary" onClick={openNewChar}>+ 新建</button>
                </div>
              </div>
              <div className="grid-list" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {characters.map(ch => {
                  const sel = selected.has(ch.name);
                  const isDefault = WEREWOLF_DEFAULTS.includes(ch.name);
                  return (
                    <button key={ch.name}
                      className={`char-card ${sel ? 'selected' : ''}`}
                      onClick={() => toggleCharacter(ch.name)}
                      onContextMenu={e => { e.preventDefault(); openEditChar(ch); }}
                    >
                      <div className="char-avatar">{ch.name[0]}</div>
                      <div className="char-info">
                        <div className="char-name">{ch.name}{isDefault && isRulesMode && rulesTab === 'ww' && <span style={{fontSize:10,color:'var(--text-2)',marginLeft:4}}>默认</span>}</div>
                        <div className="char-tag">{sel ? '已选' : '点击选择'}</div>
                      </div>
                    </button>
                  );
                })}
                {characters.length === 0 && (
                  <div className="muted" style={{ padding: 16, fontSize: 13, textAlign: 'center' }}>还没有角色，点击"+ 新建"创建</div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* ===== Free Mode: Scene selection + Enter ===== */}
        {!isRulesMode && (
          <>
            <section className="panel" style={{ border: 0, borderRadius: 8, marginTop: 24 }}>
              <div className="panel-body">
                <div className="section-row" style={{ marginBottom: 12 }}>
                  <div className="label" style={{ fontSize: 15, fontWeight: 600 }}>场景</div>
                  <button className="btn btn-small btn-primary" onClick={openNewScene}>+ 新建</button>
                </div>
                <div className="grid-list">
                  {scenes.map((scene: Scene) => (
                    <button key={scene.scene_id}
                      className={`item-card ${activeScene?.scene_id === scene.scene_id ? 'selected' : ''}`}
                      onClick={() => selectScene(scene)}
                      onContextMenu={e => { e.preventDefault(); openEditScene(scene); }}
                    >
                      <div className="item-card-title">
                        <span>{scene.name}</span>
                        <span className="item-actions" onClick={e => e.stopPropagation()}>
                          <button className="btn btn-small" onClick={() => openEditScene(scene)}>编辑</button>
                          <button className="btn btn-small btn-danger" onClick={() => deleteScene(scene)}>删除</button>
                        </span>
                      </div>
                      <div className="item-card-desc">{shortText(scene.description, 150)}</div>
                    </button>
                  ))}
                  {scenes.length === 0 && (
                    <div className="muted" style={{ padding: 16, fontSize: 13, textAlign: 'center' }}>还没有场景，点击"+ 新建"创建</div>
                  )}
                </div>
              </div>
            </section>

            <div style={{ display: 'flex', gap: 12, marginTop: 24, justifyContent: 'center' }}>
              <button className="btn btn-primary" disabled={selectedNames.length === 0 || !activeScene} onClick={start}>
                进入场景（{selectedNames.length} 个角色）
              </button>
            </div>
          </>
        )}

        {/* ===== Rules Mode: Werewolf / Script ===== */}
        {isRulesMode && (
          <section className="panel" style={{ border: 0, borderRadius: 8, marginTop: 24 }}>
            <div className="panel-body">
              <div className="section-row" style={{ marginBottom: 16 }}>
                <div className="label" style={{ fontSize: 15, fontWeight: 600 }}>游戏类型</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className={`chip ${rulesTab === 'ww' ? 'active' : ''}`} onClick={() => setRulesTab('ww')}>狼人杀</button>
                  <button className={`chip ${rulesTab === 'script' ? 'active' : ''}`} onClick={() => setRulesTab('script')}>剧本杀</button>
                </div>
              </div>

              {rulesTab === 'ww' && (
                <div>
                  <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>
                    选择5个以上角色即可开始。默认角色（苏哲、林诗、老王、小美、阿强）自动选中。
                    {missingDefaults.length > 0 && (
                      <>
                        {'  '}缺少 {missingDefaults.length} 个默认角色。
                        <button className="btn btn-small" style={{marginLeft:8}} disabled={loading} onClick={createDefaults}>
                          {loading ? '创建中...' : '一键创建默认角色'}
                        </button>
                      </>
                    )}
                  </p>
                  {roomPlayers.length > 0 && (
                    <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
                      房间：{roomCode} | 真人玩家：{roomPlayers.join('、')}
                    </p>
                  )}
                  <button className="btn btn-primary" disabled={selectedNames.length < 5} onClick={startWWGame}>
                    开始狼人杀（{selectedNames.length} 个角色）
                  </button>
                  <button className="btn btn-small" style={{marginLeft:8}} onClick={() => setShowAdvanced(!showAdvanced)}>
                    {showAdvanced ? '收起' : '高级选项'}
                  </button>
                  {showAdvanced && (
                    <div className="card" style={{marginTop:12, padding:12, background:'var(--bg-2)'}}>
                      <div style={{fontSize:13, fontWeight:600, marginBottom:8}}>职业配置</div>
                      <div className="kv" style={{gridTemplateColumns:'auto 1fr', gap:6}}>
                        {[
                          {key:'wolf', label:'狼人', min:0, max:5},
                          {key:'seer', label:'预言家', min:0, max:1},
                          {key:'witch', label:'女巫', min:0, max:1},
                          {key:'hunter', label:'猎人', min:0, max:1},
                          {key:'villager', label:'村民', min:0, max:10},
                        ].map(r => (
                          <div key={r.key} className="section-row" style={{justifyContent:'space-between', width:'100%'}}>
                            <span style={{fontSize:13}}>{r.label}</span>
                            <div style={{display:'flex', gap:4, alignItems:'center'}}>
                              <button className="btn btn-small" disabled={(roleConfig[r.key]||0) <= r.min}
                                onClick={() => setRoleConfig(rc => ({...rc, [r.key]: (rc[r.key]||0)-1}))}>-</button>
                              <span style={{width:28, textAlign:'center', fontSize:13}}>{roleConfig[r.key]||0}</span>
                              <button className="btn btn-small" disabled={(roleConfig[r.key]||0) >= r.max}
                                onClick={() => setRoleConfig(rc => ({...rc, [r.key]: (rc[r.key]||0)+1}))}>+</button>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{fontSize:12, color:'var(--text-2)', marginTop:8}}>
                        职业总数：{Object.values(roleConfig).reduce((a,b)=>a+b,0)} / 选中角色：{selectedNames.length}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {rulesTab === 'script' && (
                <div>
                  <textarea
                    value={scriptPrompt}
                    onChange={e => setScriptPrompt(e.target.value)}
                    placeholder="描述你想玩的剧本，例如：民国悬疑、一栋别墅里发生命案，5个角色各有秘密..."
                    rows={3}
                    style={{ width: '100%', marginBottom: 8 }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                    <button className="btn btn-primary" disabled={!scriptPrompt || generating} onClick={genScript}>
                      {generating ? '生成中...' : 'AI 生成剧本'}
                    </button>
                  </div>
                  {scriptJson && (
                    <div>
                      <textarea readOnly value={scriptJson} rows={8} style={{ width: '100%', fontSize: 12, fontFamily: 'monospace', marginBottom: 8 }} />
                      <button className="btn btn-primary" disabled={loading} onClick={startScript}>
                        {loading ? '加载中...' : '加载剧本并开始'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {status && <div className="status" style={{ marginTop: 12, textAlign: 'center', fontSize: 13, color: 'var(--text-2)' }}>{status}</div>}

        {/* ===== Character Modal ===== */}
        {modalType === 'char' && (
          <div className="modal-overlay" onClick={closeModal}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 500 }}>
              <div className="modal-header">
                <h3>{editTarget ? '编辑角色' : '新建角色'}</h3>
                <button className="btn btn-small" onClick={closeModal}>X</button>
              </div>
              <div className="modal-body">
                <div className="form-grid">
                  <div className="form-row">
                    <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="角色名" />
                    <input value={formVoice} onChange={e => setFormVoice(e.target.value)} placeholder="说话风格" />
                  </div>
                  <textarea value={formPersona} onChange={e => setFormPersona(e.target.value)} placeholder="人格设定：性格、动机、禁忌、关系等" rows={4} />
                  <textarea value={formBg} onChange={e => setFormBg(e.target.value)} placeholder="背景故事" rows={3} />
                  <div className="form-row">
                    <input style={{ flex: 1 }} value={formKeyword} onChange={e => setFormKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && generateChar()} placeholder="AI 生成：输入关键词" />
                    <button className="btn" disabled={generating} onClick={generateChar}>{generating ? '生成中...' : 'AI 生成'}</button>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn" onClick={closeModal}>取消</button>
                <button className="btn btn-primary" disabled={loading} onClick={saveChar}>{loading ? '保存中...' : '保存'}</button>
              </div>
            </div>
          </div>
        )}

        {/* ===== Scene Modal ===== */}
        {modalType === 'scene' && (
          <div className="modal-overlay" onClick={closeModal}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 500 }}>
              <div className="modal-header">
                <h3>{editTarget ? '编辑场景' : '新建场景'}</h3>
                <button className="btn btn-small" onClick={closeModal}>X</button>
              </div>
              <div className="modal-body">
                <div className="form-grid">
                  <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="场景名" />
                  <textarea value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="场景描述：地点、冲突、已知事实、开局状态等" rows={5} />
                  <div className="form-row">
                    <input style={{ flex: 1 }} value={formKeyword} onChange={e => setFormKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && generateScene()} placeholder="AI 生成：输入关键词" />
                    <button className="btn" disabled={generating} onClick={generateScene}>{generating ? '生成中...' : 'AI 生成'}</button>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn" onClick={closeModal}>取消</button>
                <button className="btn btn-primary" disabled={loading} onClick={saveScene}>{loading ? '保存中...' : '保存'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
