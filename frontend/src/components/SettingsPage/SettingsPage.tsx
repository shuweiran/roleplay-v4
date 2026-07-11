import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client';
import { useAppStore } from '../../store/appStore';
import './SettingsPage.css';

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  description: string;
  strengths: string[];
  suitable_for: string[];
}

export function SettingsPage() {
  const goHome = useAppStore(s => s.goHome);
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [model, setModel] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [showModels, setShowModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState('zh');
  const [trackActivity, setTrackActivity] = useState('auto');

  // Character state
  const [charModalOpen, setCharModalOpen] = useState(false);
  const [editingChar, setEditingChar] = useState<any>(null);
  const [charFormName, setCharFormName] = useState('');
  const [charFormPersona, setCharFormPersona] = useState('');
  const [charFormVoice, setCharFormVoice] = useState('');
  const [charGenKeywords, setCharGenKeywords] = useState('');
  const [charGenLoading, setCharGenLoading] = useState(false);

  // Scene state
  const [sceneModalOpen, setSceneModalOpen] = useState(false);
  const [editingScene, setEditingScene] = useState<any>(null);
  const [sceneFormId, setSceneFormId] = useState('');
  const [sceneFormName, setSceneFormName] = useState('');
  const [sceneFormDesc, setSceneFormDesc] = useState('');
  const [sceneGenKeywords, setSceneGenKeywords] = useState('');
  const [sceneGenLoading, setSceneGenLoading] = useState(false);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'character' | 'scene'; name: string; id?: string } | null>(null);

  const store = useAppStore();

  const refreshData = useCallback(async () => {
    await useAppStore.getState().loadState();
  }, []);

  // ── Character handlers ──
  const openNewChar = () => {
    setEditingChar(null);
    setCharFormName('');
    setCharFormPersona('');
    setCharFormVoice('');
    setCharModalOpen(true);
  };

  const openEditChar = (c: any) => {
    setEditingChar(c);
    setCharFormName(c.name || '');
    setCharFormPersona(c.persona || '');
    setCharFormVoice(c.voice || '');
    setCharModalOpen(true);
  };

  const saveCharacter = async () => {
    if (!charFormName.trim()) return;
    try {
      if (editingChar) {
        await api.updateCharacter(editingChar.name, {
          name: charFormName.trim(),
          persona: charFormPersona,
          voice: charFormVoice,
        });
      } else {
        await api.createCharacter({
          name: charFormName.trim(),
          persona: charFormPersona,
          voice: charFormVoice,
        });
      }
      setCharModalOpen(false);
      await refreshData();
    } catch (e: any) {
      setMessage(e.message || '操作失败');
      setMessageType('error');
    }
  };

  const deleteCharacter = async (name: string) => {
    try {
      await api.deleteCharacter(name);
      setDeleteConfirm(null);
      await refreshData();
    } catch (e: any) {
      setMessage(e.message || '删除失败');
      setMessageType('error');
      setDeleteConfirm(null);
    }
  };

  const generateCharacter = async () => {
    if (!charGenKeywords.trim()) return;
    setCharGenLoading(true);
    try {
      const result = await api.generateCharacter(charGenKeywords.trim());
      if (result.character) {
        setEditingChar(null);
        setCharFormName(result.character.name || '');
        setCharFormPersona(result.character.persona || '');
        setCharFormVoice(result.character.voice || '');
        setCharModalOpen(true);
      }
      setCharGenKeywords('');
      await refreshData();
    } catch (e: any) {
      setMessage(e.message || '生成失败');
      setMessageType('error');
    }
    setCharGenLoading(false);
  };

  // ── Scene handlers ──
  const openNewScene = () => {
    setEditingScene(null);
    setSceneFormId('');
    setSceneFormName('');
    setSceneFormDesc('');
    setSceneModalOpen(true);
  };

  const openEditScene = (s: any) => {
    setEditingScene(s);
    setSceneFormId(s.scene_id || '');
    setSceneFormName(s.name || '');
    setSceneFormDesc(s.description || '');
    setSceneModalOpen(true);
  };

  const saveScene = async () => {
    if (!sceneFormId.trim() || !sceneFormName.trim()) return;
    try {
      if (editingScene) {
        await api.updateScene(editingScene.scene_id, {
          scene_id: sceneFormId.trim(),
          name: sceneFormName.trim(),
          description: sceneFormDesc,
        });
      } else {
        await api.createScene({
          scene_id: sceneFormId.trim(),
          name: sceneFormName.trim(),
          description: sceneFormDesc,
        });
      }
      setSceneModalOpen(false);
      await refreshData();
    } catch (e: any) {
      setMessage(e.message || '操作失败');
      setMessageType('error');
    }
  };

  const deleteScene = async (id: string) => {
    try {
      await api.deleteScene(id);
      setDeleteConfirm(null);
      await refreshData();
    } catch (e: any) {
      setMessage(e.message || '删除失败');
      setMessageType('error');
      setDeleteConfirm(null);
    }
  };

  const generateScene = async () => {
    if (!sceneGenKeywords.trim()) return;
    setSceneGenLoading(true);
    try {
      const result = await api.generateScene(sceneGenKeywords.trim());
      if (result.scene) {
        setEditingScene(null);
        setSceneFormId(result.scene.scene_id || '');
        setSceneFormName(result.scene.name || '');
        setSceneFormDesc(result.scene.description || '');
        setSceneModalOpen(true);
      }
      setSceneGenKeywords('');
      await refreshData();
    } catch (e: any) {
      setMessage(e.message || '生成失败');
      setMessageType('error');
    }
    setSceneGenLoading(false);
  };

  useEffect(() => {
    Promise.all([
      api.getApiKeyConfig().catch(() => ({ api_base: 'https://api.deepseek.com', model: 'deepseek-chat', has_key: false, language: 'zh', track_activity: 'auto' })),
      api.getModelRecommendations().catch(() => ({ models: [] })),
      api.getLanguage().catch(() => ({ language: 'zh' }))
    ]).then(([config, modelData, langData]) => {
      setApiBase(config.api_base || 'https://api.deepseek.com');
      setModel(config.model || 'deepseek-chat');
      setModels(modelData.models || []);
      if (config.language) setLanguage(config.language);
      if (langData.language) setLanguage(langData.language);
      if (config.track_activity) setTrackActivity(config.track_activity);
    });
  }, []);

  const selectModel = (m: ModelInfo) => {
    setModel(m.id);
    setApiBase(m.base_url);
    setShowModels(false);
    setMessage('已选择 ' + m.name + '，请填写对应的 API Key');
    setMessageType('success');
  };

  const handleSave = async () => {
    setMessage('');
    if (!apiKey.trim()) {
      setMessage('请输入 API Key');
      setMessageType('error');
      return;
    }
    setSaving(true);
    try {
      await api.setApiKeyConfig(apiKey.trim(), apiBase.trim(), model.trim(), language, trackActivity);
      setMessage('配置已保存并生效');
      setMessageType('success');
    } catch (e: any) {
      setMessage(e.message || '保存失败');
      setMessageType('error');
    }
    setSaving(false);
  };

  const selectedModel = models.find(m => m.id === model);

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="btn btn-text" onClick={goHome}>{'<'} 返回</button>
        <h1>{'\u2699\uFE0F'} 设置</h1>
      </div>

      <div className="settings-card">
        <h3>{'\uD83D\uDD11'} API 配置</h3>
        <p className="settings-hint">配置 AI 模型密钥，所有数据仅保存在本地。</p>

        <label>API Key</label>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-... 或你的 API Key" />

        <label>API 地址</label>
        <input type="text" value={apiBase} onChange={e => setApiBase(e.target.value)} placeholder="https://api.deepseek.com" />

        <div className="model-select-row">
          <label>模型</label>
          <div className="model-input-group">
            <input type="text" value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek-chat" className="model-input" />
            <button className="btn btn-sm" onClick={() => setShowModels(!showModels)}>
              {showModels ? '收起推荐' : '查看推荐模型'}
            </button>
          </div>
        </div>

        {selectedModel && (
          <div className="selected-model-info">
            <div className="model-name">{selectedModel.provider} {'\u00B7'} {selectedModel.name}</div>
            <div className="model-desc">{selectedModel.description}</div>
            <div className="model-tags">
              {selectedModel.strengths.map(s => <span key={s} className="tag tag-green">{s}</span>)}
              {selectedModel.suitable_for.map(s => <span key={s} className="tag tag-blue">{s}</span>)}
            </div>
          </div>
        )}

        <div className="settings-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>

        {message && (
          <div className={'settings-message ' + messageType}>{message}</div>
        )}
      </div>

      {showModels && (
        <div className="settings-card">
          <h3>推荐模型</h3>
          <p className="settings-hint">点击选择模型，不同模型适合不同场景。</p>
          <div className="model-list">
            {models.length === 0 ? (
              <p className="loading-text">加载中...</p>
            ) : (
              models.map(m => (
                <div key={m.id} className={'model-item ' + (model === m.id ? 'active' : '')} onClick={() => selectModel(m)}>
                  <div className="model-item-header">
                    <span className="model-item-name">{m.name}</span>
                    <span className="model-item-provider">{m.provider}</span>
                    {model === m.id && <span className="model-current-badge">当前</span>}
                  </div>
                  <div className="model-item-desc">{m.description}</div>
                  <div className="model-tags">
                    {m.strengths.map(s => <span key={s} className="tag tag-green">{s}</span>)}
                    {m.suitable_for.map(s => <span key={s} className="tag tag-blue">{s}</span>)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/*** Characters Section ***/}
      <div className="settings-card">
        <div className="manage-section">
          <h3>{'\uD83E\uDDD9\u200D♂️'} 素材库 - 角色</h3>
          <button className="btn btn-sm" onClick={openNewChar}>+ 新建</button>
        </div>

        <div className="generate-row">
          <input
            type="text"
            value={charGenKeywords}
            onChange={e => setCharGenKeywords(e.target.value)}
            placeholder="输入关键词，AI 生成角色..."
            onKeyDown={e => { if (e.key === 'Enter') generateCharacter(); }}
          />
          <button className="btn btn-sm" onClick={generateCharacter} disabled={charGenLoading}>
            {charGenLoading ? '生成中...' : 'AI 生成'}
          </button>
        </div>

        {store.characters.length === 0 ? (
          <p className="empty-hint">暂无角色，点击上方按钮新建或 AI 生成</p>
        ) : (
          store.characters.map((c: any) => (
            <div key={c.name} className="manage-item">
              <div className="manage-item-info">
                <div className="manage-item-name">{c.name}</div>
                <div className="manage-item-preview">{(c.persona || '').substring(0, 50)}{(c.persona || '').length > 50 ? '...' : ''}</div>
                {c.voice && <div className="manage-item-voice">{'\uD83C\uDF99'} {c.voice}</div>}
              </div>
              <div className="manage-item-actions">
                <button className="btn btn-sm" onClick={() => openEditChar(c)}>编辑</button>
                <button className="btn btn-sm btn-danger" onClick={() => setDeleteConfirm({ type: 'character', name: c.name })}>删除</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/*** Scenes Section ***/}
      <div className="settings-card">
        <div className="manage-section">
          <h3>{'\uD83C\uDF0D'} 素材库 - 场景</h3>
          <button className="btn btn-sm" onClick={openNewScene}>+ 新建</button>
        </div>

        <div className="generate-row">
          <input
            type="text"
            value={sceneGenKeywords}
            onChange={e => setSceneGenKeywords(e.target.value)}
            placeholder="输入关键词，AI 生成场景..."
            onKeyDown={e => { if (e.key === 'Enter') generateScene(); }}
          />
          <button className="btn btn-sm" onClick={generateScene} disabled={sceneGenLoading}>
            {sceneGenLoading ? '生成中...' : 'AI 生成'}
          </button>
        </div>

        {store.scenes.length === 0 ? (
          <p className="empty-hint">暂无场景，点击上方按钮新建或 AI 生成</p>
        ) : (
          store.scenes.map((s: any) => (
            <div key={s.scene_id || s.name} className="manage-item">
              <div className="manage-item-info">
                <div className="manage-item-name">{s.name} <span style={{ fontSize:'0.75rem', color:'var(--text-dim, #888)', marginLeft:4 }}>({s.scene_id})</span></div>
                <div className="manage-item-preview">{(s.description || '').substring(0, 50)}{(s.description || '').length > 50 ? '...' : ''}</div>
              </div>
              <div className="manage-item-actions">
                <button className="btn btn-sm" onClick={() => openEditScene(s)}>编辑</button>
                <button className="btn btn-sm btn-danger" onClick={() => setDeleteConfirm({ type: 'scene', name: s.name, id: s.scene_id })}>删除</button>
              </div>
            </div>
          ))
        )}
      </div>

      {/*** Language & Activity Section ***/}
      <div className="settings-card">
        <h3>{'\uD83C\uDF10'} 多语言与轨道活跃度</h3>

        <label>界面与提示语言</label>
        <select
          value={language}
          onChange={async e => {
            const newLang = e.target.value;
            setLanguage(newLang);
            await api.setLanguage(newLang);
          }}
          className="settings-select"
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
          <option value="jp">日本語</option>
          <option value="kr">한국어</option>
        </select>

        <label>轨道活跃度</label>
        <select
          value={trackActivity}
          onChange={e => setTrackActivity(e.target.value)}
          className="settings-select"
        >
          <option value="auto">自动（一般模式最低，剧本杀最高）</option>
          <option value="minimal">最低（尽量保持轨道不变）</option>
          <option value="maximum">最高（频繁调整轨道）</option>
        </select>
      </div>

      <div className="settings-card">
        <h3>使用提示</h3>
        <ul className="tips-list">
          <li><strong>自由/导演模式</strong> — 推荐 DeepSeek Chat 或 Claude Sonnet，对话自然流畅</li>
          <li><strong>狼人杀模式</strong> — 推荐 DeepSeek R1 或 GPT-4o，需要强推理能力</li>
          <li><strong>多角色场景</strong> — Claude Sonnet 角色一致性表现最佳</li>
          <li><strong>快速测试</strong> — 用 DeepSeek Chat 或 GPT-4o Mini，响应最快</li>
        </ul>
      </div>

      {/*** Character Modal ***/}
      {charModalOpen && (
        <div className="modal-overlay" onClick={() => setCharModalOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>{editingChar ? '编辑角色' : '新建角色'}</h3>

            <label>角色名</label>
            <input type="text" value={charFormName} onChange={e => setCharFormName(e.target.value)} placeholder="例如：福尔摩斯" />

            <label>人设（persona）</label>
            <textarea value={charFormPersona} onChange={e => setCharFormPersona(e.target.value)} placeholder="描述角色的性格、背景..." />

            <label>语音</label>
            <input type="text" value={charFormVoice} onChange={e => setCharFormVoice(e.target.value)} placeholder="例如：zh-CN-XiaoxiaoNeural" />

            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setCharModalOpen(false)}>取消</button>
              <button className="btn btn-sm btn-primary" onClick={saveCharacter}>
                {editingChar ? '保存修改' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*** Scene Modal ***/}
      {sceneModalOpen && (
        <div className="modal-overlay" onClick={() => setSceneModalOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>{editingScene ? '编辑场景' : '新建场景'}</h3>

            <label>场景 ID</label>
            <input type="text" value={sceneFormId} onChange={e => setSceneFormId(e.target.value)} placeholder="例如：mystery_room" />

            <label>场景名称</label>
            <input type="text" value={sceneFormName} onChange={e => setSceneFormName(e.target.value)} placeholder="例如：神秘房间" />

            <label>场景描述</label>
            <textarea value={sceneFormDesc} onChange={e => setSceneFormDesc(e.target.value)} placeholder="描述场景的设定..." />

            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setSceneModalOpen(false)}>取消</button>
              <button className="btn btn-sm btn-primary" onClick={saveScene}>
                {editingScene ? '保存修改' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*** Delete Confirmation Modal ***/}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p style={{ color:'var(--text-secondary, #ccc)', fontSize:'0.9rem' }}>
              确定要删除 {deleteConfirm.type === 'character' ? '角色' : '场景'}
              「<strong>{deleteConfirm.name}</strong>」吗？此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setDeleteConfirm(null)}>取消</button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  if (deleteConfirm.type === 'character') {
                    deleteCharacter(deleteConfirm.name);
                  } else {
                    deleteScene(deleteConfirm.id || deleteConfirm.name);
                  }
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
