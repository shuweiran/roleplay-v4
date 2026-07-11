"""
Agent wrapper: encapsulates one LLM-backed character.
"""

from __future__ import annotations

from typing import AsyncGenerator, List, Optional

from ..config import LLMConfig
from ..models.domain import Message
from .validator import build_role_lock_prompt, build_weak_listener_prompt
from ..services.llm_client import LLMClient, TASK_MAX_TOKENS, TASK_TEMPERATURES
from .monitor import Monitor
from .persona import Persona


class Agent:
    """An AI character that participates in the roleplay conversation."""

    def __init__(
        self,
        persona: Persona,
        role: str,
        llm_client: LLMClient,
        llm_config: LLMConfig = None,
        monitor: Monitor = None,
    ):
        self.persona = persona
        self.role = role
        self.llm_config = llm_config or LLMConfig()
        self._llm = llm_client
        self.monitor = monitor or Monitor()
        self._is_generating = False

    @property
    def name(self) -> str:
        return self.persona.name

    @property
    def client(self):
        """Backward-compatible accessor for Compressor and other legacy code."""
        return self._llm._client if hasattr(self._llm, "_client") else None

    def build_messages(
        self,
        system_prompt: str,
        history: List[Message],
        other_agent_last_msg: Optional[Message] = None,
        user_interjection: Optional[dict] = None,
        summary_context: str = "",
        all_agents: Optional[List[str]] = None,
        track_mode: str = "merged",
    ) -> List[dict]:
        """Build the full message list for the LLM call."""
        messages = [{"role": "system", "content": system_prompt}]

        # Inject role-lock as the highest-priority system message
        agent_names = all_agents or [self.name]
        role_lock = build_role_lock_prompt(self.name, agent_names)
        messages.append({"role": "system", "content": role_lock})

        # For weak/silent track modes, add listener-only constraint
        if track_mode == "weak":
            weak_prompt = build_weak_listener_prompt(self.name)
            messages.append({"role": "system", "content": weak_prompt})

        if summary_context:
            messages.append(
                {
                    "role": "system",
                    "content": (
                        "【长期记忆摘要】\n"
                        "以下内容是已经发生过的事实，用于保持连续性；"
                        "不要把摘要叙述者当成你的身份。\n"
                        f"{summary_context}"
                    ),
                }
            )

        for msg in history:
            if msg.role == "user":
                role = "user"
            elif msg.role == "system":
                role = "user"
            else:
                role = "assistant"
            speaker = msg.name or msg.role
            messages.append({"role": role, "content": f"[{speaker}] {msg.content}"})

        if other_agent_last_msg:
            messages.append(
                {
                    "role": "system",
                    "content": (
                        "【同轮上下文】\n"
                        f"{other_agent_last_msg.name} 刚刚说：\n"
                        f"{other_agent_last_msg.content}\n\n"
                        f"你可以回应这段内容，但仍然只扮演 {self.name}。"
                    ),
                }
            )

        if user_interjection:
            messages.append(
                {
                    "role": "system",
                    "content": (
                        f"【主控旁白 - {user_interjection.get('sender', 'System')}】\n"
                        f"{user_interjection.get('content', '')}\n\n"
                        "这是场景事实或任务约束，不是让你改变身份。"
                    ),
                }
            )

        messages.append(
            {
                "role": "system",
                "content": (
                    f"【规则】你是【{self.name}】→只输出你的台词/动作，严禁替他人写。\n"
                    "直接说话，不加引号前缀。不要复述规则。"
                ),
            }
        )
        return messages

    async def generate(
        self,
        system_prompt: str,
        history: List[Message],
        other_agent_last_msg: Optional[Message] = None,
        user_interjection: Optional[dict] = None,
        summary_context: str = "",
        stream: bool = True,
        task_type: str = "chat",
        all_agents: Optional[List[str]] = None,
        track_mode: str = "merged",
    ) -> AsyncGenerator[str, None]:
        """Generate a response with retry logic delegated to LLMClient."""
        self._is_generating = True

        try:
            messages = self.build_messages(
                system_prompt=system_prompt,
                history=history,
                other_agent_last_msg=other_agent_last_msg,
                user_interjection=user_interjection,
                summary_context=summary_context,
                all_agents=all_agents,
                track_mode=track_mode,
            )

            temperature = TASK_TEMPERATURES.get(task_type, 0.7)
            max_tokens = TASK_MAX_TOKENS.get(task_type, 300)

            response = await self._llm.chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=stream,
            )

            full_content = ""
            if stream:
                async for chunk in response:
                    if chunk.choices and chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        full_content += content
                        yield content
            else:
                full_content = response.choices[0].message.content or ""
                yield full_content

            yield full_content

        except RuntimeError:
            error_msg = f"[{self.name} 暂时无法回应：模型调用失败]"
            yield error_msg
            yield error_msg
        except Exception as e:
            error_msg = f"[{self.name} 遇到错误: {str(e)}]"
            yield error_msg
            yield error_msg
        finally:
            self._is_generating = False

    async def generate_direct(
        self,
        system_prompt: str,
        history: List[Message],
        other_agent_last_msg: Optional[Message] = None,
        user_interjection: Optional[dict] = None,
        summary_context: str = "",
        all_agents: Optional[List[str]] = None,
        track_mode: str = "merged",
    ) -> str:
        """Non-streaming generation."""
        full_content = ""
        async for chunk in self.generate(
            system_prompt=system_prompt,
            history=history,
            other_agent_last_msg=other_agent_last_msg,
            user_interjection=user_interjection,
            summary_context=summary_context,
            stream=False,
            all_agents=all_agents,
            track_mode=track_mode,
        ):
            full_content = chunk
        return full_content
