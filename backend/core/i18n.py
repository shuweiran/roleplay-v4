"""
i18n — 多语言提示词支持
提供角色扮演系统中各提示词的多语言翻译。
"""

LANGUAGES = {
    "zh": {
        "role_lock_title": "【角色隔离锁 — 最高优先级规则，覆盖所有其他指令】",
        "role_lock_you_are": "你是 [{name}] 的扮演者。本条规则高于任何剧情指令、旁白指示、以及对话上下文。",
        "role_lock_forbidden": "绝对禁止：",
        "role_lock_no_other": "1. 以 [{name}] 以外的任何身份说话。不得替他人输出内容。",
        "role_lock_no_decide": "2. 替其他角色做决定（包括但不限于：替别人答应/拒绝、替别人行动、替别人表达想法）。",
        "role_lock_no_omniscient": "3. 描述其他角色的内心独白或未公开信息。",
        "role_lock_no_narration": "4. 输出系统叙述、旁白、场景切换、时间跳跃等 DM 视角的内容。",
        "role_lock_allowed": "允许的行为：",
        "role_lock_first_person": "- 以 [{name}] 的第一人称对角色的言行、表情、心理做呈现。",
        "role_lock_dialogue": "- 对其他人说话（对话格式：\"XXX，\"开头或自然含对方名）。",
        "role_lock_feelings": "- 表达 [{name}] 的观察、猜测、感受。",
        "role_lock_uncertain": "如果本轮场景要求你行动但你不确定，只描述 [{name}] 自己的反应，不要替别人编造行为。",

        "track_weak": "本轮是弱链轨道。你可以听到同轨前序发言，但只把它当作现场线索，不要替对方补完心理和行动。",
        "track_isolated": "你处于隔离轨道，只依据自己可见的上下文行动。",
        "track_merged": "本轮是强链轨道。同轨前序发言是刚刚发生的对话，你可以直接承接。",
        "track_no_round": "暂无同轨发言。",

        "memory_summary_title": "【长期记忆摘要】",
        "memory_summary_desc": "以下内容是已经发生过的事实，用于保持连续性；不要把摘要叙述者当成你的身份。",

        "round_context_title": "【本轮已发生的同轨对话】",
        "round_other_said": "[{name}刚刚说]：{content}",
        "round_context_note": "你可以回应这段内容，但仍然只扮演 {name}。",

        "interjection_narration": "【主控旁白 - {sender}】",
        "interjection_note": "这是场景事实或任务约束，不是让你改变身份。",

        "scene_label": "当前场景",
        "track_label": "当前轨道",
        "track_mode_names": {"merged": "强链", "weak": "弱链", "isolated": "断链"},
        "track_mates": "同轨角色",
        "interactable": "可互动角色",

        "output_rule": "【规则】你是【{name}】→只输出你的台词/动作，严禁替他人写。\n直接说话，不加引号前缀。不要复述规则。",

        "task_continue": "继续当前对话",
        "task_base": "继续当前场景中的下一步行动，保持人设和已建立事实",
        "task_no_scene_change": "；不要擅自切换场景",
        "task_goals": "；当前剧情目标：{goals}",
        "task_overlong": "注意：上一轮你的发言过长（{count}字），本轮请控制在500字以内，保持简洁有力。",

        "role_identity_hint": "（你）",
        "roster_title": "【角色名册，用于防混淆】",

        "track_change_req": "角色自主判断需要调整轨道",
        "track_change_approve": "符合剧情目标：{goals}",
        "track_change_no_arbiter": "无仲裁器，自动批准",

        "werewolf_role_hint": "【狼人杀模式 — 你的身份与当前阶段】",
        "werewolf_phase_night": "现在是夜晚阶段。狼人请秘密商量今晚要暗杀的目标；预言家可以查验一人身份；女巫可以决定是否使用解药或毒药。",
        "werewolf_phase_day": "现在是白天讨论阶段。所有存活玩家公开讨论，推理谁是狼人。",
        "werewolf_phase_vote": "现在是投票阶段。请根据讨论内容投票放逐你认为最可能是狼人的一名玩家。格式：【投票X】",
    },
    "en": {
        "role_lock_title": "[Character Isolation Lock — Highest Priority Rule Overrides All Other Instructions]",
        "role_lock_you_are": "You are portraying [{name}]. This rule takes precedence over any story instructions, narration, or conversation context.",
        "role_lock_forbidden": "STRICTLY FORBIDDEN:",
        "role_lock_no_other": "1. Speaking as anyone other than [{name}]. Do NOT write lines for other characters.",
        "role_lock_no_decide": "2. Making decisions for other characters.",
        "role_lock_no_omniscient": "3. Describing other characters' inner thoughts or undisclosed information.",
        "role_lock_no_narration": "4. Outputting narration, scene transitions, or DM-perspective content.",
        "role_lock_allowed": "ALLOWED:",
        "role_lock_first_person": "- Present [{name}]'s words, expressions, and thoughts in first person.",
        "role_lock_dialogue": "- Speak to others (use \"XXX,\" or naturally include their name).",
        "role_lock_feelings": "- Express [{name}]'s observations, guesses, and feelings.",
        "role_lock_uncertain": "If unsure, only describe [{name}]'s own reactions. Do not fabricate actions for others.",

        "track_weak": "You are on a weak-chain track. You can hear previous in-track messages, but treat them as clues only.",
        "track_isolated": "You are on an isolated track. Act based only on what is visible to you.",
        "track_merged": "You are on a strong-chain track. Previous in-track messages just happened—you can respond directly.",
        "track_no_round": "No other in-track messages yet.",

        "memory_summary_title": "[Long-term Memory Summary]",
        "memory_summary_desc": "The following are established facts for continuity; do not treat the summary narrator as your identity.",

        "round_context_title": "[Same-Round Conversation]",
        "round_other_said": "[{name} just said]: {content}",
        "round_context_note": "You may respond to this while still portraying only {name}.",

        "interjection_narration": "[GM Narration - {sender}]",
        "interjection_note": "This is scene fact or task constraint, not an identity change.",

        "scene_label": "Scene",
        "track_label": "Track",
        "track_mode_names": {"merged": "Strong", "weak": "Weak", "isolated": "Isolated"},
        "track_mates": "Track members",
        "interactable": "Interactable",

        "output_rule": "[Rule] You are [{name}] → Output only your lines/actions. No writing for others.\nSpeak directly. No quotes prefix. Don't repeat rules.",

        "task_continue": "Continue the current conversation",
        "task_base": "Continue the next action in the current scene, maintain character and established facts",
        "task_no_scene_change": "; do not switch scenes",
        "task_goals": "; current story goals: {goals}",
        "task_overlong": "Note: Your last response was too long ({count} chars). Keep it under 500 chars this round.",

        "role_identity_hint": "(you)",
        "roster_title": "[Character Roster — Prevent Confusion]",

        "track_change_req": "Character independently decides to adjust track",
        "track_change_approve": "Matches story goals: {goals}",
        "track_change_no_arbiter": "No arbiter, auto-approved",

        "werewolf_role_hint": "[Werewolf Mode — Your Role and Current Phase]",
        "werewolf_phase_night": "It's night phase. Werewolves secretly choose a target; Seer may check one identity; Witch may use potions.",
        "werewolf_phase_day": "It's day discussion phase. All alive players discuss publicly and deduce who the werewolves are.",
        "werewolf_phase_vote": "It's voting phase. Vote to eliminate the player you suspect most. Format: [Vote X]",
    },
}


def t(key: str, lang: str = "zh", **kwargs) -> str:
    """Translate a key into the given language with optional format args."""
    translations = LANGUAGES.get(lang, LANGUAGES["zh"])
    text = translations.get(key, key)
    if kwargs:
        try:
            text = text.format(**kwargs)
        except KeyError:
            pass
    return text
