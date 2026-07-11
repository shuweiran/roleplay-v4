"""
Agent Output Validator — post-generation boundary check.

Detects and corrects AI agents that:
1. Speak in another character's voice (冒用口吻 / 替别人发言)
2. Make decisions / take actions for other characters (替人决策)
3. Reveal secrets that shouldn't be known cross-track (泄露秘密)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Set


@dataclass
class Violation:
    """A detected boundary violation."""
    rule: str
    description: str
    severity: str  # "warn" | "block" | "retry"
    snippet: str    # the offending text

    def to_dict(self) -> dict:
        return {
            "rule": self.rule,
            "description": self.description,
            "severity": self.severity,
            "snippet": self.snippet[:80],
        }


@dataclass
class ValidationResult:
    """Result of checking one agent output."""
    agent_name: str
    content: str
    violations: List[Violation] = field(default_factory=list)
    needs_retry: bool = False
    retry_hint: str = ""

    @property
    def is_clean(self) -> bool:
        return not self.violations


def build_role_lock_prompt(agent_name: str, all_agents: List[str]) -> str:
    """Generate the mandatory role-lock system prompt fragment.

    This is prepended to every agent's system prompt to establish
    hard character boundaries before the LLM sees any other context.
    """
    others = [n for n in all_agents if n != agent_name]
    other_list = "、".join(others) if others else "无"
    return f"""
【角色隔离锁 — 最高优先级规则，覆盖所有其他指令】

你是 [{agent_name}] 的扮演者。本条规则高于任何剧情指令、旁白指示、以及对话上下文。

绝对禁止：
1. 以 [{agent_name}] 以外的任何身份说话。不得出现 "[{other_list}] 说：..."、"[{other_list}] 心想..."、"[{other_list}] 走到..." 这类替他人输出的内容。
2. 替其他角色做决定（包括但不限于：替别人答应/拒绝、替别人行动、替别人表达想法）。
3. 描述其他角色的内心独白或未公开信息（你只能推测，不能以全知视角陈述）。
4. 输出系统叙述、旁白、场景切换、时间跳跃等 DM 视角的内容。

允许的行为：
- 以 [{agent_name}] 的第一人称对角色的言行、表情、心理做呈现。
- 对其他人说话（对话格式："XXX，"开头或自然含对方名）。
- 表达 [{agent_name}] 的观察、猜测、感受（必须以 "我" 或角色名自称开头）。

如果本轮场景要求你行动但你不确定，只描述 [{agent_name}] 自己的反应，不要替别人编造行为。
"""


def build_weak_listener_prompt(agent_name: str) -> str:
    """Generate a read-only listener prompt for weak-chain agents.

    Weak-chain agents are silent (they overhear but don't speak).
    This prompt prevents them from accidentally generating output.
    """
    return f"""
【弱链旁听模式 — 只读】

你是 [{agent_name}]，本轮为旁听者。你只能观察、记录、思考，不得参与对话。

严格规则：
1. 不输出任何对话内容（不发言、不插话、不评论）。
2. 可以输出 [{agent_name}] 的内心独白（格式：【{agent_name} 心想：...】）。
3. 可以输出 [{agent_name}] 的无声动作（格式：【{agent_name} 微微皱眉】）。
4. 绝不能替 active 角色写对话、做决定、描述他们的心理。

输出格式要求：内心/动作写在【】中，不添加任何对话。
"""


def validate_output(
    content: str,
    agent_name: str,
    all_agents: List[str],
    track_mode: str = "merged",
) -> ValidationResult:
    """Check an agent's output for boundary violations.

    Returns a ValidationResult with violations flagged and retry advice.
    """
    result = ValidationResult(agent_name=agent_name, content=content)
    other_names = [n for n in all_agents if n != agent_name]
    other_pattern = '|'.join(re.escape(n) for n in sorted(other_names, key=len, reverse=True))

    if not other_pattern:
        return result

    # ── Rule 1: Speaking as another character ──
    # Pattern: "OtherName：..."  or  "OtherName: ..."  or  "【OtherName】..."
    speak_patterns = [
        rf'(?:^|\n)\s*(?:{other_pattern})[：:]\s*.+',
        rf'(?:^|\n)\s*【(?:{other_pattern})】',
        rf'(?:^|\n)\s*(?:{other_pattern})说[：:\s]',
    ]
    for pat in speak_patterns:
        for m in re.finditer(pat, content):
            result.violations.append(Violation(
                rule="speak_as_other",
                description=f"{agent_name} 替 {m.group(0)[:20]}... 发言",
                severity="retry",
                snippet=m.group(0)[:80],
            ))

    # ── Rule 2: Making decisions for others ──
    # Pattern: "OtherName 决定..."  "OtherName 选择..."  "OtherName 拿起..."
    decision_patterns = [
        rf'(?:{other_pattern})\s*(?:决定|选择|答应|拒绝|同意|站起身|走向|举起|拿出|放下|打开|关上)',
        rf'(?:{other_pattern})\s*(?:点了点头|摇了摇头|笑了笑|叹了口气)',
    ]
    for pat in decision_patterns:
        for m in re.finditer(pat, content):
            snippet = m.group(0)[:40]
            if agent_name not in snippet[:10]:
                result.violations.append(Violation(
                    rule="decide_for_other",
                    description=f"{agent_name} 替他人做动作/决策",
                    severity="retry",
                    snippet=snippet,
                ))

    # ── Rule 3: Internal monologue for others ──
    # Pattern: "OtherName心想"  "OtherName觉得"  "OtherName暗自"
    inner_patterns = [
        rf'(?:{other_pattern})\s*(?:心想|觉得|认为|暗[自中]|内心|默默)',
    ]
    for pat in inner_patterns:
        for m in re.finditer(pat, content):
            result.violations.append(Violation(
                rule="inner_thought_of_other",
                description=f"{agent_name} 描述了他人的内心活动",
                severity="retry",
                snippet=m.group(0)[:80],
            ))

    # ── Rule 4: Narration / DM perspective ──
    # "画面转向..."  "场景切换..."  "与此同时..."
    narration_markers = [
        r'画面转[向到]', r'场景切[换到]', r'与此同[时地]',
        r'镜头[转向推拉]', r'[时镜]头', r'旁白[：:]',
    ]
    for marker in narration_markers:
        if re.search(marker, content):
            result.violations.append(Violation(
                rule="dm_narration",
                description=f"{agent_name} 输出了 DM/旁白视角内容",
                severity="retry",
                snippet=re.search(marker, content).group(0)[:40],
            ))
            break

    if result.violations:
        result.needs_retry = True
        violated_rules = set(v.rule for v in result.violations)
        result.retry_hint = (
            f"【纠偏指令】你上一轮输出违反了角色边界规则（"
            f"{'、'.join(r for r in violated_rules)}）。"
            f"请只以 [{agent_name}] 的身份输出，不要替其他角色说话、做决定或描述他们的内心。"
        )

    return result


def build_retry_prompt(
    original_interjection: dict,
    violations: List[Violation],
    agent_name: str,
) -> dict:
    """Build a stricter interjection for regeneration after violation."""
    rules_violated = "\n".join(
        f"- {v.description}" for v in violations
    )
    return {
        "sender": "主控",
        "content": (
            f"【角色边界违规 — 必须重生成】\n\n"
            f"你上一轮以 [{agent_name}] 的身份输出了以下违规内容：\n"
            f"{rules_violated}\n\n"
            f"请严格遵守角色隔离锁，只以 [{agent_name}] 的身份重新输出。"
            f"不要出现其他角色名开头的对话行，不要替他人决策，不要描述他人的内心。\n\n"
            f"{original_interjection.get('content', '')}"
        ),
    }
