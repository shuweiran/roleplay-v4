"""
TrackRequest — 角色主动向主控申请轨道变更系统

功能:
1. 角色可向主控申请：断链→弱链 / 弱链→强链（需主控审批）
2. 角色申请断链（强链→弱链 / 弱链→断链）：自动批准，无需审批
3. 主控根据剧情目标审核并决定批准/驳回
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set

from .track_manager import TrackInstance


class RequestStatus(str, Enum):
    PENDING = "pending"        # 待审批
    APPROVED = "approved"      # 已批准
    REJECTED = "rejected"      # 已驳回
    AUTO_APPROVED = "auto_approved"  # 自动批准（断链申请）


class RequestType(str, Enum):
    """申请类型"""
    DISCONNECT = "disconnect"        # 断链：strong/weak → isolated（自动批准）
    WEAKEN = "weaken"                # 减弱：strong → weak（需审批）
    STRENGTHEN = "strengthen"        # 增强：weak/isolated → strong（需审批）
    CONNECT = "connect"              # 连接：isolated → weak（需审批）


# 轨道强度等级，用于判断申请类型
TRACK_STRENGTH = {
    "isolated": 0,
    "weak": 1,
    "merged": 2,
}


@dataclass
class TrackChangeRequest:
    """一条轨道变更申请"""
    id: str = field(default_factory=lambda: f"treq_{uuid.uuid4().hex[:8]}")
    agent_name: str = ""           # 申请角色
    target_agent: str = ""         # 目标角色（申请与之建立/断开轨道）
    current_track_id: str = ""     # 当前轨道ID
    request_type: RequestType = RequestType.CONNECT
    target_mode: str = ""          # 目标轨道模式: merged / weak / isolated
    reason: str = ""               # 申请理由
    status: RequestStatus = RequestStatus.PENDING
    arbiter_reasoning: str = ""    # 主控审批理由
    created_at: float = field(default_factory=time.time)
    resolved_at: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "agent_name": self.agent_name,
            "target_agent": self.target_agent,
            "current_track_id": self.current_track_id,
            "request_type": self.request_type.value,
            "target_mode": self.target_mode,
            "reason": self.reason,
            "status": self.status.value,
            "arbiter_reasoning": self.arbiter_reasoning,
            "created_at": self.created_at,
            "resolved_at": self.resolved_at,
        }


def determine_request_type(current_mode: str, target_mode: str) -> RequestType:
    """根据当前轨道和目标轨道判断申请类型"""
    current_strength = TRACK_STRENGTH.get(current_mode, 0)
    target_strength = TRACK_STRENGTH.get(target_mode, 0)

    if target_strength < current_strength:
        # 申请减弱连接强度
        if target_strength == 0:
            return RequestType.DISCONNECT  # 断链（自动批准）
        else:
            return RequestType.WEAKEN      # 减弱
    else:
        # 申请增强连接强度
        if current_strength == 0:
            return RequestType.CONNECT     # 建立连接
        else:
            return RequestType.STRENGTHEN  # 增强


class TrackRequestManager:
    """轨道变更申请管理器"""

    def __init__(self, emit_callback: Optional[Callable] = None):
        self._requests: Dict[str, TrackChangeRequest] = {}
        self._emit = emit_callback or (lambda *a, **kw: None)

    def submit_request(
        self,
        agent_name: str,
        target_agent: str,
        current_mode: str,
        target_mode: str,
        current_track_id: str = "",
        reason: str = "",
    ) -> TrackChangeRequest:
        """
        提交轨道变更申请。

        如果是断链申请（isolated），自动批准。
        否则标记为待审批，等待主控决定。
        """
        req_type = determine_request_type(current_mode, target_mode)

        req = TrackChangeRequest(
            agent_name=agent_name,
            target_agent=target_agent,
            current_track_id=current_track_id,
            request_type=req_type,
            target_mode=target_mode,
            reason=reason,
        )

        # 断链申请：自动批准
        if req_type == RequestType.DISCONNECT:
            req.status = RequestStatus.AUTO_APPROVED
            req.arbiter_reasoning = "断链申请：自动批准"
            req.resolved_at = time.time()
        else:
            req.status = RequestStatus.PENDING

        self._requests[req.id] = req
        self._emit("track_request_created", req.to_dict())
        return req

    def approve_request(
        self,
        request_id: str,
        reasoning: str = "",
    ) -> Optional[TrackChangeRequest]:
        """主控批准申请"""
        req = self._requests.get(request_id)
        if not req or req.status != RequestStatus.PENDING:
            return None
        req.status = RequestStatus.APPROVED
        req.arbiter_reasoning = reasoning or "主控批准"
        req.resolved_at = time.time()
        self._emit("track_request_resolved", req.to_dict())
        return req

    def reject_request(
        self,
        request_id: str,
        reasoning: str = "",
    ) -> Optional[TrackChangeRequest]:
        """主控驳回申请"""
        req = self._requests.get(request_id)
        if not req or req.status != RequestStatus.PENDING:
            return None
        req.status = RequestStatus.REJECTED
        req.arbiter_reasoning = reasoning or "主控驳回"
        req.resolved_at = time.time()
        self._emit("track_request_resolved", req.to_dict())
        return req

    def get_pending_requests(self) -> List[TrackChangeRequest]:
        """获取所有待审批的申请"""
        return [r for r in self._requests.values() if r.status == RequestStatus.PENDING]

    def get_requests_by_agent(self, agent_name: str) -> List[TrackChangeRequest]:
        """获取某个角色的所有申请"""
        return [r for r in self._requests.values() if r.agent_name == agent_name]

    def get_resolved_requests(self, limit: int = 20) -> List[TrackChangeRequest]:
        """获取已处理的申请"""
        resolved = [r for r in self._requests.values() if r.status != RequestStatus.PENDING]
        return sorted(resolved, key=lambda r: r.resolved_at or 0, reverse=True)[:limit]

    def get_request(self, request_id: str) -> Optional[TrackChangeRequest]:
        return self._requests.get(request_id)

    def cleanup_old(self, max_age: float = 3600) -> int:
        """清理超过指定时间的已处理申请"""
        now = time.time()
        to_remove = []
        for rid, req in self._requests.items():
            if req.status != RequestStatus.PENDING and req.resolved_at:
                if now - req.resolved_at > max_age:
                    to_remove.append(rid)
        for rid in to_remove:
            del self._requests[rid]
        return len(to_remove)

    def get_all_requests(self) -> List[TrackChangeRequest]:
        return list(self._requests.values())


# 全局实例
request_manager = TrackRequestManager()
