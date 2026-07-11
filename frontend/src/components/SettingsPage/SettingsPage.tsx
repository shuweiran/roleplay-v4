import { useState, useEffect } from 'react';
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

  useEffect(() => {
    Promise.all([
      api.getApiKeyConfig().catch(() => ({ api_base: 'https://api.deepseek.com', model: 'deepseek-chat', has_key: false, language: 'zh', track_activity: 'auto' })),
      api.getModelRecommendations().catch(() => ({ models: [] }))
    ]).then(([config, modelData]) => {
      setApiBase(config.api_base || 'https://api.deepseek.com');
      setModel(config.model || 'deepseek-chat');
      setModels(modelData.models || []);
      if (config.language) setLanguage(config.language);
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

      <div className="settings-card">
        <h3>{'\uD83C\uDF10'} 多语言与轨道活跃度</h3>

        <label>界面与提示语言</label>
        <select
          value={language}
          onChange={e => setLanguage(e.target.value)}
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
    </div>
  );
}
