import { useState } from 'react';
import { useAppStore } from '../../store/appStore';

export function LoginPage() {
  const login = useAppStore(s => s.login);
  const loginError = useAppStore(s => s.loginError);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    await login(code.trim().toUpperCase());
    setLoading(false);
  };

  return (
    <div className="app-shell">
      <div className="login-container">
        <div className="login-card">
          <div className="login-logo">
            <div className="brand-mark">R</div>
          </div>
          <h1>Roleplay v4</h1>
          <p className="login-subtitle">多智能体角色扮演系统</p>

          <form onSubmit={handleSubmit} className="login-form">
            <div className="form-group">
              <label>邀请码</label>
              <input
                type="text"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
                placeholder="请输入邀请码"
                maxLength={8}
                autoFocus
                className="login-input"
              />
            </div>

            {loginError && <div className="login-error">{loginError}</div>}

            <button
              type="submit"
              className="btn btn-primary login-btn"
              disabled={loading || !code.trim()}
            >
              {loading ? '验证中...' : '进入'}
            </button>
          </form>

          <p className="login-footer">
            需要邀请码？请联系管理员
          </p>
        </div>
      </div>
    </div>
  );
}
