import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { useAppStore } from '../../store/appStore';
import './SettingsPage.css';

export function SettingsPage() {
  const goHome = useAppStore(s => s.goHome);
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [model, setModel] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');

  useEffect(() => {
    api.getApiKeyConfig().then(data => {
      setApiBase(data.api_base || 'https://api.deepseek.com');
      setModel(data.model || 'deepseek-v4-flash');
    }).catch(() => {});
  }, []);

  const handleSave = async () => {
    setMessage('');
    if (!apiKey.trim()) {
      setMessage('请输入 API Key');
      setMessageType('error');
      return;
    }
    try {
      await api.setApiKeyConfig(apiKey.trim(), apiBase.trim(), model.trim());
      setMessage('API Key 已保存并生效');
      setMessageType('success');
    } catch (e: any) {
      setMessage(e.message || '保存失败');
      setMessageType('error');
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="btn btn-text" onClick={goHome}>← 返回</button>
        <h1>⚙️ 设置</h1>
      </div>
      <div className="settings-card">
        <h3>API 配置</h3>
        <p className="settings-hint">设置你的 API Key，用于 AI 模型调用。密钥仅保存在本地。</p>
        
        <label>API Key</label>
        <input 
          type="password" 
          value={apiKey} 
          onChange={e => setApiKey(e.target.value)} 
          placeholder="sk-..."
        />
        
        <label>API Base URL</label>
        <input 
          type="text" 
          value={apiBase} 
          onChange={e => setApiBase(e.target.value)} 
          placeholder="https://api.deepseek.com"
        />
        
        <label>模型名称</label>
        <input 
          type="text" 
          value={model} 
          onChange={e => setModel(e.target.value)} 
          placeholder="deepseek-v4-flash"
        />
        
        {message && (
          <div className={`settings-message ${messageType}`}>{message}</div>
        )}
        
        <button className="btn btn-primary" onClick={handleSave} style={{ marginTop: 16 }}>
          保存配置
        </button>
      </div>
    </div>
  );
}
