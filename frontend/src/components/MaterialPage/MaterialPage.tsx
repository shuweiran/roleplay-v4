import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { api } from '../../api/client';

type Tab = 'characters' | 'scenes';

function shortText(text = '', limit = 110) {
  return text.length > limit ? `${text.slice(0, limit)}...` : text || '暂无描述';
}

export function MaterialPage() {
  const { characters, scenes, loadState, goToView,
    // P-0802-P4：玩家本人角色（绑定 player_id）改名同步用
    playerId, boundCharacterName, setBoundCharacterName, currentPlayer, setCurrentPlayer,
  } = useAppStore();
  const [tab, setTab] = useState<Tab>('characters');

  // Char form
  const [editingChar, setEditingChar] = useState<any>(null);
  const [chName, setChName] = useState('');
  const [chPersona, setChPersona] = useState('');
  const [chVoice, setChVoice] = useState('');
  const [chBg, setChBg] = useState('');
  const [chKeyword, setChKeyword] = useState('');

  // Scene form
  const [editingScene, setEditingScene] = useState<any>(null);
  const [scName, setScName] = useState('');
  const [scDesc, setScDesc] = useState('');
  const [scKeyword, setScKeyword] = useState('');

  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => { loadState(); }, []);

  const resetChar = () => { setEditingChar(null); setChName(''); setChPersona(''); setChVoice(''); setChBg(''); setChKeyword(''); };
  const openEditChar = (ch: any) => { setTab('characters'); setEditingChar(ch); setChName(ch.name); setChPersona(ch.persona || ''); setChVoice(ch.voice || ''); setChBg(ch.background || ''); };

  const saveChar = async () => {
    const name = chName.trim();
    if (!name) return;
    setSaving(true);
    try {
      if (editingChar) {
        const isBound = editingChar.player_id === playerId || editingChar.name === boundCharacterName;
        if (isBound && name !== editingChar.name) {
          // P-0802-P4（改造方案 §4.1）：玩家本人角色（已绑定 player_id）改名 → 改调局中改名端点
          // （角色库改名 + 四处运行态同步 + 撞名校验② + 失败回滚）
          await api.playerRename(editingChar.name, name);
          setBoundCharacterName(name);
          if (currentPlayer === editingChar.name) setCurrentPlayer(name);
        } else {
          // 非绑定角色改名 / 绑定角色编辑资料（不改名）→ 仍走原 PUT（client.ts 按绑定状态决定是否携带 player_id）
          await api.updateCharacter(editingChar.name, { name, persona: chPersona.trim(), voice: chVoice.trim(), background: chBg.trim() });
        }
      } else {
        // P-0802-P4：新建角色 —— 当前无绑定角色时自动绑定为「玩家本人角色」，之后创建的不携带 player_id（见 client.ts）
        await api.createCharacter({ name, persona: chPersona.trim(), voice: chVoice.trim(), background: chBg.trim() });
      }
      resetChar(); await loadState();
    } finally { setSaving(false); }
  };

  const deleteChar = async (name: string) => {
    if (!confirm(`删除角色「${name}」？`)) return;
    await api.deleteCharacter(name);
    if (editingChar?.name === name) resetChar();
    await loadState();
  };

  const generateChar = async () => {
    const kw = chKeyword.trim();
    if (!kw || generating) return;
    setGenerating(true);
    try { await api.generateCharacter(kw); setChKeyword(''); await loadState(); } finally { setGenerating(false); }
  };

  const resetScene = () => { setEditingScene(null); setScName(''); setScDesc(''); setScKeyword(''); };
  const openEditScene = (s: any) => { setTab('scenes'); setEditingScene(s); setScName(s.name); setScDesc(s.description || ''); };

  const saveScene = async () => {
    const name = scName.trim();
    if (!name) return;
    setSaving(true);
    try {
      if (editingScene) {
        await api.updateScene(editingScene.scene_id, { scene_id: editingScene.scene_id, name, description: scDesc.trim(), agent_names: editingScene.initial_agent_names || [] });
      } else {
        await api.createScene({ scene_id: `scene_${Date.now()}`, name, description: scDesc.trim(), agent_names: [] });
      }
      resetScene(); await loadState();
    } finally { setSaving(false); }
  };

  const deleteScene = async (s: any) => {
    if (!confirm(`删除场景「${s.name}」？`)) return;
    await api.deleteScene(s.scene_id);
    if (editingScene?.scene_id === s.scene_id) resetScene();
    await loadState();
  };

  const generateScene = async () => {
    const kw = scKeyword.trim();
    if (!kw || generating) return;
    setGenerating(true);
    try { await api.generateScene(kw); setScKeyword(''); await loadState(); } finally { setGenerating(false); }
  };

  return (
    <div className="material-page">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div><div className="brand-title">素材库</div><div className="brand-subtitle">管理角色、场景和剧本</div></div>
        </div>
        <div className="topbar-spacer" />
        <div className="form-row">
          <button className={`btn btn-small ${tab === 'characters' ? 'btn-primary' : ''}`} onClick={() => setTab('characters')}>角色</button>
          <button className={`btn btn-small ${tab === 'scenes' ? 'btn-primary' : ''}`} onClick={() => setTab('scenes')}>场景</button>
        </div>
        <button className="btn" onClick={() => goToView('scene')}>✕ 关闭</button>
      </header>

      <div className="material-body">
        {tab === 'characters' ? (
          <div className="material-grid">
            <div className="material-editor">
              <h3 className="card-title">{editingChar ? '编辑角色' : '新建角色'}</h3>
              <div className="form-grid">
                <div className="form-row">
                  <input value={chName} onChange={e => setChName(e.target.value)} placeholder="角色名" />
                  <input value={chVoice} onChange={e => setChVoice(e.target.value)} placeholder="说话风格" />
                </div>
                <textarea value={chPersona} onChange={e => setChPersona(e.target.value)} placeholder="人格设定：性格、动机、禁忌、关系等" rows={5} />
                <textarea value={chBg} onChange={e => setChBg(e.target.value)} placeholder="背景故事：经历、记忆、长期目标等" rows={3} />
                <div className="form-row">
                  <input style={{ flex: 1 }} value={chKeyword} onChange={e => setChKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && generateChar()} placeholder="AI 生成：输入关键词" />
                  <button className="btn" disabled={generating} onClick={generateChar}>{generating ? '生成中...' : 'AI 生成'}</button>
                </div>
                <div className="form-row" style={{ justifyContent: 'flex-end' }}>
                  {editingChar && <button className="btn" onClick={resetChar}>取消</button>}
                  <button className="btn btn-primary" disabled={saving} onClick={saveChar}>{saving ? '保存中...' : '保存角色'}</button>
                </div>
              </div>
            </div>
            <div className="material-list">
              <div className="list-header">角色列表（{characters.length}）</div>
              {characters.map((ch: any) => (
                <div key={ch.name} className="material-item">
                  <div className="item-main" onClick={() => openEditChar(ch)}>
                    <div className="char-avatar-sm">{ch.name[0]}</div>
                    <div>
                      <div className="item-name">{ch.name}</div>
                      <div className="item-preview">{shortText(ch.persona || ch.background, 100)}</div>
                    </div>
                  </div>
                  <div className="item-actions">
                    <button className="btn btn-small btn-danger" onClick={() => deleteChar(ch.name)}>删除</button>
                  </div>
                </div>
              ))}
              {characters.length === 0 && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>还没有角色，在左侧创建</div>}
            </div>
          </div>
        ) : (
          <div className="material-grid">
            <div className="material-editor">
              <h3 className="card-title">{editingScene ? '编辑场景' : '新建场景'}</h3>
              <div className="form-grid">
                <input value={scName} onChange={e => setScName(e.target.value)} placeholder="场景名" />
                <textarea value={scDesc} onChange={e => setScDesc(e.target.value)} placeholder="场景描述：地点、冲突、已知事实、开局状态" rows={6} />
                <div className="form-row">
                  <input style={{ flex: 1 }} value={scKeyword} onChange={e => setScKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && generateScene()} placeholder="AI 生成：输入关键词" />
                  <button className="btn" disabled={generating} onClick={generateScene}>{generating ? '生成中...' : 'AI 生成'}</button>
                </div>
                <div className="form-row" style={{ justifyContent: 'flex-end' }}>
                  {editingScene && <button className="btn" onClick={resetScene}>取消</button>}
                  <button className="btn btn-primary" disabled={saving} onClick={saveScene}>{saving ? '保存中...' : '保存场景'}</button>
                </div>
              </div>
            </div>
            <div className="material-list">
              <div className="list-header">场景列表（{scenes.length}）</div>
              {scenes.map((s: any) => (
                <div key={s.scene_id} className="material-item">
                  <div className="item-main" onClick={() => openEditScene(s)}>
                    <div className="scene-icon">🏗️</div>
                    <div>
                      <div className="item-name">{s.name}</div>
                      <div className="item-preview">{shortText(s.description, 100)}</div>
                    </div>
                  </div>
                  <div className="item-actions">
                    <button className="btn btn-small btn-danger" onClick={() => deleteScene(s)}>删除</button>
                  </div>
                </div>
              ))}
              {scenes.length === 0 && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>还没有场景，在左侧创建</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
