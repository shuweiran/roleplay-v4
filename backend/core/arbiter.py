"""
Arbiter — LLM-based DM / conversation director (v4: 铁轨模式).

v4 changes from v3:
- Receives shared LLMClient via constructor (no own httpx client)
- Uses LLMClient.call_json() for structured JSON responses
- Keeps all same prompt templates and business logic
"""

from __future__ import annotations

import json
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple

from ..config import AppConfig, ModeConfig
from ..models.domain import Track, TrackMode
from ..services.llm_client import LLMClient


class UserInputCategory(Enum):
    SUPPLEMENT = "supplement"
    TOPIC_SWITCH = "topic_switch"
    COMMAND = "command"
    NEW_PLOT = "new_plot"


# ── Prompt templates (from v3, unchanged) ──────────────────────────

CONFIGURE_TRACKS_PROMPT = """你是一个角色扮演游戏的主控（DM）。请分析当前对话状态，为本轮配置铁轨。

当前场景：{scene_description}

可用角色：{agent_names}
【重要】只有以上列出的 "{agent_names}" 是可用角色。场景描述中可能提到其他角色名，但请忽略它们，不要为它们分配轨道。

对话历史摘要：
{history_summary}

上一轮轨道配置（避免重复）：
{previous_tracks}

━━━━ 核心规则：根据剧情紧张度决定轨道规模和角色关系 ━━━━

请先评估当前剧情紧张度等级：
- 紧张度低  (1-3/10)：日常对话、探索、平淡期 → 至少 2-3 人活跃轨道
- 紧张度中  (4-6/10)：冲突酝酿、互动升温 → 至少半数为 active，其余可 silent
- 紧张度高  (7-10/10)：激烈的冲突、高潮场面 → 所有角色 active 参与

同时考虑角色关系和剧情发展：
- 有密切关系的角色应优先分配到同一轨道
- 当前剧情线涉及的关联角色应共享轨道上下文
- 非必要时不要将角色设为 offline；优先设为 silent 保留旁听能力

━━━━ 角色 action ━━━━
- "active"  → 本轮生成回复，参与对话
- "silent"  → 本轮不输出，但同步轨道上下文（旁听/观察）
- "offline" → 完全隔离，不共享上下文，不产出回复

【轮换要求】≤3 人时全部 active。4 人以上每轮必须轮换 active 角色，不要连续两轮让同一组人发言。上一轮 active 的角色本轮优先设为 silent 或 offline，让其他角色获得发言机会。

【⚠️ 禁止调度角色】以下角色已被系统/用户明确禁止本轮出场，你绝对不能为它们分配 active 或 silent（只能 offline）：
{restricted_list}
请严格遵守此限制，不要尝试让这些角色参与任何轨道。

━━━━ 轨道模式 ━━━━
- merged（强链）: 同轨道所有 active 角色共享上下文，互相直接对话
- weak（弱链）: 部分 active，部分 silent（旁听）
- isolated（分离）: 完全独立，上下文隔离

【发言顺序】agents 列表中的角色顺序即本轮发言顺序。把要让其先说话的角色排在 agents 列表前面。

请回复JSON（必须包含 reasoning 说明你的配置逻辑和轮换考虑）：
{{"reasoning": "剧情紧张度评估+轮换考虑+轨道配置理由", "tracks": [轨道列表]}}"""

INTEGRATE_OUTPUTS_PROMPT = """你是主控（DM）。请分析本轮对话并输出结构化结果。

当前场景：{scene_description}

铁轨配置：
{tracks}

各角色的本轮输出：
{agent_outputs}

要求：
1. 整合叙事：用一段连贯文字整合本轮所有角色发言，形成叙事段落。控制在 80-100 字，只写关键事实和对话结果。
2. 下一轮判断：根据本轮进展，推测下一轮应该让哪些角色出场、在什么轨道中、按什么顺序。
3. 轨道分析：说明每条轨道的强弱链判断依据。
4. 顺序说明：本轮发言顺序是否合理，下一轮顺序应如何调整。

回复JSON：
```json
{{
  "narration": "整合叙事（80-100字）",
  "scene_progress": "剧情推进描述（20-40字）",
  "next_round": {{
    "agents": ["角色名", "..."],
    "mode": "merged/weak/isolated",
    "order": ["角色名按发言顺序排列"],
    "reason": "为什么这样安排"
  }},
  "chain_analysis": {{
    "tracks": [
      {{"label": "轨道名", "mode": "强弱链", "reason": "判断理由"}}
    ]
  }}
}}
```"""

PROCESS_USER_INPUT_PROMPT = """你是一个角色扮演游戏的主控（DM）。用户给你发了一段输入，请根据分类将其转化为一段"主控旁白"。

【注意】这不是直接给用户看的！这是给角色们看的。角色应该看到场景变化/事件，而不是直接看到"用户说XXX"或"导演说XXX"。

当前场景：{scene_description}

用户输入：{text}

用户输入分类：{category}
- supplement: 补充细节或提问 → 转化为"场景中发生的变化/补充"
- topic_switch: 切换话题 → 转化为"场景转换/时间跳跃"
- new_plot: 新剧情引入 → 转化为"突发事件/新角色登场/重大发现"
- command: 命令 → 直接返回命令本身

请用主控的口吻，将用户输入转化为一段叙事旁白（30-60字）。
不要出现"用户"、"导演"等字眼。

直接回复旁白内容即可。"""

WEREWOLF_GM_PROMPT = """你是一个狼人杀游戏的主持人（GM）。你负责主持游戏流程、分配角色、宣布结果，并引导每轮讨论。

游戏规则：
1. 角色分配：从可用角色中随机分配狼人（≥2人）、预言家、女巫、其余为村民。确保平衡。
2. 夜晚阶段：
   - 狼人互相讨论（私下），选择一名目标杀害
   - 预言家查验一人身份（GM私下告知）
   - 女巫决定是否用解药救人或用毒药杀人
3. 白天阶段：
   - GM宣布夜晚结果（谁死亡，是否被救）
   - 所有存活玩家公开讨论、推理
   - 投票放逐一名疑似狼人
   - 被放逐者淘汰，不揭示身份
4. 胜负：
   - 狼人全灭 → 好人阵营胜利
   - 狼人数量 ≥ 存活的好人 → 狼人阵营胜利
5. 用户输入是玩家{{}}的发言（已由系统插入对话流中），其他角色需要回应。

当前游戏状态：
场景：{scene_description}
存活角色：{alive_agents}
当前阶段：{phase}
轮次：{round_number}

请根据当前阶段和规则，为存活角色配置本轮轨道和行动：
- 夜晚阶段：狼人 active（讨论杀害目标），预言家/女巫可 silent（待GM询问），村民 offline
- 白天讨论：所有存活者 active（公开讨论）
- 白天投票：所有存活者 active（轮流投票）

回复JSON（必须包含 role_info 标注各角色身份，用于游戏逻辑）：
{{"reasoning": "阶段说明+行动理由", "role_info": {{"角色名": "身份(werewolf/seer/witch/villager)", "alive": true/false}}, "tracks": [轨道列表]}}"""

INTEGRATE_WEREWOLF_PROMPT = """你是狼人杀游戏主持人（GM）。请分析本轮对话并输出结构化结果。

当前场景（游戏状态）：{scene_description}
铁轨配置：{tracks}
各角色的本轮输出：{agent_outputs}

你需要：
1. 管理游戏阶段流转（夜晚→白天→夜晚...）
2. 判断夜晚阶段的结果（狼人杀害目标、预言家查验、女巫用药）
3. 在白天阶段宣布死亡结果，引导讨论和投票
4. 判断投票结果，宣布放逐
5. 检查胜负条件

回复JSON：
```json
{{
  "narration": "GM旁白（宣布阶段结果、死亡、投票结果等，80-150字）",
  "scene_progress": "阶段推进描述（20-40字）",
  "phase": "当前阶段（night/day_vote/day_discuss）",
  "killed": "本轮死亡角色名（无则为空）",
  "saved": "本轮被救角色名（无则为空）",
  "exiled": "本轮被放逐角色名（无则为空）",
  "game_over": false,
  "winner": "",
  "next_round": {{
    "phase": "下一阶段",
    "agents": ["存活角色"],
    "order": ["发言顺序"],
    "reason": "为什么这样安排"
  }}
}}
```"""

# Predefined track colors
TRACK_COLORS = [
    "#4CAF50", "#2196F3", "#FF9800", "#E91E63",
    "#9C27B0", "#00BCD4", "#FF5722", "#795548",
    "#607D8B", "#8BC34A",
]


class Arbiter:
    """LLM-based conversation arbiter / DM. v4 uses shared LLMClient."""

    def __init__(self, config: AppConfig = None, llm_client: LLMClient = None):
        self.config = config or AppConfig()
        self._llm = llm_client

    # ── Track configuration ───────────────────────────────────

    async def configure_tracks(
        self,
        scene_description: str,
        agent_names: List[str],
        history_summary: str,
        mode_config: ModeConfig = None,
        previous_tracks: List[Track] = None,
        goals: List[str] = None,
        restricted_agents: Set[str] = None,
    ) -> Tuple[List[Track], str]:
        """Configure tracks for this round. Returns (tracks, reasoning)."""
        mode_config = mode_config or ModeConfig()
        restricted_agents = restricted_agents or set()
        prev_text = "(本轮为新对话，无上一轮)"
        if previous_tracks:
            prev_lines = []
            for t in previous_tracks:
                actives = [n for n, a in t.agent_actions.items() if a == "active"]
                silents = [n for n, a in t.agent_actions.items() if a == "silent"]
                prev_lines.append(f"  轨道「{t.label}」({t.mode}): active={actives}, silent={silents}")
            if prev_lines:
                prev_text = "\n".join(prev_lines)

        if mode_config.mode == "werewolf":
            prompt = WEREWOLF_GM_PROMPT.format(
                scene_description=scene_description or "狼人杀游戏",
                alive_agents=", ".join(agent_names),
                phase="day_discuss",
                round_number=1,
            )
        else:
            goals_text = ""
            if goals:
                goals_text = "\n当前剧情目标（必须严格遵守）：\n" + "\n".join(f"- {g}" for g in goals)
            restricted_list = ", ".join(sorted(restricted_agents)) if restricted_agents else "（无）"
            prompt = CONFIGURE_TRACKS_PROMPT.format(
                scene_description=scene_description or "默认场景",
                agent_names=", ".join(agent_names),
                history_summary=history_summary or "(新对话)",
                previous_tracks=prev_text,
                restricted_list=restricted_list,
            )
            # Inject goals into prompt
            prompt = prompt.replace("━━━━ 核心规则", f"{goals_text}\n\n━━━━ 核心规则")

        result = await self._llm.call_json(prompt, max_tokens=400)
        raw_tracks = result.get("tracks", [])
        reasoning = result.get("reasoning", "")

        if not raw_tracks:
            raw_tracks = self._default_tracks(agent_names)
            reasoning = "LLM未返回配置，使用默认轨道"

        # Build Track objects
        tracks = []
        assigned = set()
        for i, rt in enumerate(raw_tracks):
            names = rt.get("agents", rt.get("agent_names", []))
            if not names:
                continue
            if isinstance(names, str):
                names = [names]
            names = [n["name"] if isinstance(n, dict) and "name" in n else str(n) for n in names]
            mode = rt.get("mode", "merged")
            actions = rt.get("agent_actions", {})
            if not actions:
                if mode == "weak":
                    actions = {n: ("active" if j == 0 else "silent") for j, n in enumerate(names)}
                elif mode == "isolated":
                    actions = {n: "offline" for n in names}
                else:
                    actions = {n: "active" for n in names}
            track = Track(
                id=rt.get("id", f"track_{i}"),
                agents=names,
                agent_actions=actions,
                mode=mode,
                color=rt.get("color", TRACK_COLORS[i % len(TRACK_COLORS)]),
                label=rt.get("label", f"轨道{i+1}"),
            )
            tracks.append(track)
            for n in names:
                assigned.add(n)

        # Ensure all agents are assigned
        missing = [n for n in agent_names if n not in assigned]
        if missing:
            if tracks:
                for n in missing:
                    tracks[-1].agents.append(n)
                    tracks[-1].agent_actions[n] = "silent"
            else:
                tracks.append(Track(
                    id="main", agents=list(agent_names),
                    agent_actions={n: "silent" for n in agent_names},
                    mode="merged", label="主线", color=TRACK_COLORS[0],
                ))

        # Protagonist mode: ensure protagonist stays active
        if mode_config.mode == "protagonist" and mode_config.protagonist:
            protagonist = mode_config.protagonist
            found = False
            for track in tracks:
                if protagonist in track.agents:
                    track.agent_actions[protagonist] = "active"
                    if track.mode == "isolated":
                        track.mode = "merged"
                    found = True
            if not found:
                best_track = max(tracks, key=lambda t: len(t.active_agents)) if tracks else None
                if best_track:
                    best_track.agents.append(protagonist)
                    best_track.agent_actions[protagonist] = "active"
                else:
                    tracks.append(Track(
                        id="main", agents=[protagonist],
                        agent_actions={protagonist: "active"},
                        mode="merged", label="主线", color=TRACK_COLORS[0],
                    ))

        # Multi-track mode: ensure at least 2 tracks
        if mode_config.mode == "multi_track" and len(tracks) < 2 and len(agent_names) >= 2:
            first = agent_names[0]
            rest = agent_names[1:]
            tracks = [
                Track(id="track_a", agents=[first], agent_actions={first: "active"},
                      mode="merged", label="主线", color=TRACK_COLORS[0]),
                Track(id="track_b", agents=list(rest),
                      agent_actions={n: "active" for n in rest},
                      mode="merged", label="暗线", color=TRACK_COLORS[1]),
            ]

        # Filter out agents not in agent_names
        final_agent_names = set(agent_names)
        for track in tracks:
            track.agents = [n for n in track.agents if n in final_agent_names]
            track.agent_actions = {n: v for n, v in track.agent_actions.items() if n in final_agent_names}
            # Small groups (≤3): everyone active in merged/weak tracks
            if len(track.agents) <= 3 and track.mode in ("merged", "weak"):
                for n in track.agents:
                    track.agent_actions[n] = "active"
            # Safety: at least one active per track
            if not track.active_agents and track.agents:
                track.agent_actions[track.agents[0]] = "active"
        tracks = [t for t in tracks if t.agents]

        # ── Force rotation: if same active agents as previous round, swap ──
        if previous_tracks and len(agent_names) >= 4:
            prev_active = set()
            for pt in previous_tracks:
                for n, a in pt.agent_actions.items():
                    if a == "active":
                        prev_active.add(n)
            if prev_active:
                for track in tracks:
                    curr_active = set(track.active_agents)
                    if curr_active and curr_active == prev_active:
                        prev_silent = [n for n in track.agents if n not in prev_active and n in final_agent_names]
                        if prev_silent:
                            to_demote = list(curr_active)[-1]
                            track.agent_actions[to_demote] = "silent"
                            to_promote = prev_silent[0]
                            track.agent_actions[to_promote] = "active"
                            reasoning += f" [强制轮换：{to_demote}→silent, {to_promote}→active]"
                        break

        # ── Hard enforcement: restricted agents must be offline ──
        if restricted_agents:
            for track in tracks:
                for name in list(track.agent_actions.keys()):
                    if name in restricted_agents:
                        track.agent_actions[name] = "offline"
                        reasoning += f" [硬性禁止：{name}强制offline]"

        return tracks, reasoning

    # ── Output integration ────────────────────────────────────

    async def integrate_outputs(
        self,
        scene_description: str,
        tracks: List[Track],
        agent_outputs: List[dict],
    ) -> dict:
        """Integrate all agent outputs into a coherent narration."""
        if not agent_outputs:
            return {"narration": "(本轮无角色输出)", "scene_progress": ""}

        tracks_str = json.dumps([t.to_dict() for t in tracks], ensure_ascii=False, indent=2)
        outputs_str = "\n".join([
            f"[{o['agent_name']}]: {o['content'][:300]}"
            for o in agent_outputs
        ])

        if self.config.mode.mode == "werewolf":
            prompt = INTEGRATE_WEREWOLF_PROMPT.format(
                scene_description=scene_description or "狼人杀游戏",
                tracks=tracks_str,
                agent_outputs=outputs_str,
            )
        else:
            prompt = INTEGRATE_OUTPUTS_PROMPT.format(
                scene_description=scene_description or "默认场景",
                tracks=tracks_str,
                agent_outputs=outputs_str,
            )

        result = await self._llm.call_json(prompt, max_tokens=800)
        if not result:
            print(f"[arbiter] integrate_outputs: call_json returned empty dict, retrying...")
            result = await self._llm.call_json(prompt, max_tokens=800)
        return {
            "narration": (result.get("narration", "") or "")[:150],
            "scene_progress": (result.get("scene_progress", "") or "")[:60],
            "next_round": result.get("next_round", {}),
            "chain_analysis": result.get("chain_analysis", {}),
        }

    # ── User input handling ───────────────────────────────────

    async def classify_user_input(
        self, text: str,
        mode: str = "always",
        context_history: list = None,
    ) -> UserInputCategory:
        """Classify user input category."""
        stripped = text.strip().lower()
        if stripped.startswith("/"):
            return UserInputCategory.COMMAND

        if mode == "always":
            ctx = "(无历史)"
            if context_history:
                ctx = "\n".join(f"[{m.name}]: {m.content[:80]}" for m in context_history[-4:])
            prompt = (
                f"请判断以下用户输入属于哪一类：\n"
                f"(1) 补充 - 用户在现有剧情上补充细节或提问\n"
                f"(2) 切换话题 - 用户有意改变当前话题\n"
                f"(3) 命令 - 系统命令\n"
                f"(4) 新剧情 - 用户引入新的剧情线\n"
                f"用户输入：{text[:200]}\n历史上下文：\n{ctx}\n"
                f"请只回复一个词：补充/切换话题/命令/新剧情"
            )
            result = await self._llm.call_json(prompt, max_tokens=20)
            # Fallback to simple text response
            raw = str(result)
            if "切换话题" in raw:
                return UserInputCategory.TOPIC_SWITCH
            elif "新剧情" in raw:
                return UserInputCategory.NEW_PLOT
            elif "命令" in raw:
                return UserInputCategory.COMMAND
            return UserInputCategory.SUPPLEMENT

        smart = ["/打断", "/介入", "/导演", "/interrupt", "/say", "/plot"]
        if any(text.strip().startswith(t) for t in smart):
            return UserInputCategory.NEW_PLOT
        return UserInputCategory.SUPPLEMENT

    async def process_user_input(
        self,
        text: str,
        category: UserInputCategory,
        scene_description: str = "",
        agent_names: List[str] = None,
        goals: List[str] = None,
    ) -> str:
        """Convert user input into DM narration."""
        if category == UserInputCategory.COMMAND:
            return text

        category_labels = {
            UserInputCategory.SUPPLEMENT: "补充",
            UserInputCategory.TOPIC_SWITCH: "切换话题",
            UserInputCategory.NEW_PLOT: "新剧情",
        }
        cat_label = category_labels.get(category, "其他")

        goals_text = ""
        if goals:
            goals_text = "\n当前剧情目标：\n" + "\n".join(f"- {g}" for g in goals)

        agent_text = ""
        if agent_names:
            agent_text = "可用角色：" + ", ".join(agent_names)

        prompt = (
            '你是一个角色扮演游戏的主控（DM）。用户给你发了一段输入，请将其转化为一段“主控旁白”。\n\n'
            f'当前场景：{scene_description}\n{agent_text}{goals_text}\n\n'
            f'用户输入：{text[:300]}\n用户输入分类：{cat_label}\n\n'
            '请用主控的口吻，将用户输入转化为一段叙事旁白（30-60字）。\n'
            '不要出现“用户”、“导演”等字眼。\n可以引导特定角色做出反应，但不要直接替角色说话。\n\n'
            '直接回复旁白内容即可。'
        )

        # Use simple chat completion for narration (not JSON)
        try:
            msgs = [
                {"role": "system", "content": "你是一个角色扮演主控，回复简洁的叙事旁白。"},
                {"role": "user", "content": prompt},
            ]
            response = await self._llm.chat_completion(
                messages=msgs, max_tokens=120, temperature=0.1, stream=False,
            )
            narration = (response.choices[0].message.content or "").strip()
            if not narration:
                narration = f"【场景变化】{text[:100]}"
            return narration
        except Exception:
            return f"【场景变化】{text[:100]}"

    # ── Generation ─────────────────────────────────────────────

    async def generate_scene(self, keywords: str = "", current_scene: str = "") -> dict:
        """AI-generate a scene."""
        context = ""
        if current_scene:
            context = f"当前场景：{current_scene}\n\n请基于此生成一个相关但不同的场景。"

        prompt = (
            f"你是一个角色扮演游戏的主控（DM）。请生成一个场景设定。\n\n"
            f"{context}\n"
            f"用户提示：{keywords[:100] if keywords else '生成一个适合多角色互动的场景'}\n\n"
            f'请返回JSON格式：\n{{"name": "场景名称", "description": "场景描述（80-120字）"}}\n'
            f'只返回JSON，不要其他文字。'
        )

        result = await self._llm.call_json(prompt, max_tokens=300)
        if not result or "name" not in result:
            return {"name": "新场景", "description": "一个普通的场景。"}
        return result

    async def generate_character(self, keywords: str = "") -> dict:
        """AI-generate a character."""
        prompt = (
            "You are a roleplay DM. Generate a character.\n"
            f"User prompt: {keywords[:100] if keywords else 'Generate an interesting character'}\n"
            'Return JSON only: {"name": "name", "persona": "personality 60-100 chars", '
            '"voice": "speaking style 30-60 chars", "background": "backstory 50-80 chars"}'
        )
        result = await self._llm.call_json(prompt, max_tokens=400)
        if not result or "name" not in result:
            return {"name": "路人", "persona": "普通角色", "voice": "正常", "background": "未知"}
        return result

    # ── Default fallback ───────────────────────────────────────

    @staticmethod
    def _default_tracks(agent_names: List[str]) -> List[dict]:
        """Default track config when LLM fails."""
        n = len(agent_names)
        if n <= 2:
            return [{"id": "main", "agents": list(agent_names),
                     "agent_actions": {n: "active" for n in agent_names},
                     "mode": "merged", "label": "主线"}]
        elif n <= 4:
            return [{"id": "main", "agents": list(agent_names),
                     "agent_actions": {n: "active" for n in agent_names},
                     "mode": "merged", "label": "主线"}]
        else:
            active_count = max(n - 1, 4)
            main_active = agent_names[:active_count]
            silent_rest = agent_names[active_count:]
            actions = {n: "active" for n in main_active}
            actions.update({n: "silent" for n in silent_rest})
            return [{"id": "main", "agents": list(agent_names),
                     "agent_actions": actions, "mode": "merged", "label": "主线"}]
