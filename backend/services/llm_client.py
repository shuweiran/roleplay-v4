"""
Shared LLM client — single httpx connection pool for all Agent + Arbiter calls.

Consolidates retry logic, JSON parsing, cost tracking, and timeout handling
that were previously duplicated in Agent._call_llm_with_retry() and
Arbiter._call_llm_json().

Design:
- Created ONCE at app startup (in lifespan)
- Injected into Agent, Arbiter, Compressor via constructor
- All components share the same httpx.AsyncClient connection pool
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, List, Optional

import httpx
from openai import AsyncOpenAI

from ..config import LLMConfig, MonitorConfig
from ..core.monitor import Monitor

# Task-type specific parameters (ported from v3 agent.py)
TASK_TEMPERATURES: Dict[str, float] = {
    "chat": 0.7,
    "summary": 0.1,
    "arbiter": 0.1,
    "lore": 0.3,
}

TASK_MAX_TOKENS: Dict[str, int] = {
    "chat": 600,
    "summary": 80,
    "arbiter": 300,
    "lore": 100,
}


class LLMClient:
    """Unified LLM client with retry, cost tracking, and JSON parsing.

    All Agent and Arbiter calls go through this single client.
    """

    def __init__(self, config: LLMConfig, monitor: Monitor, monitor_config: MonitorConfig = None):
        self.config = config
        self.monitor = monitor
        self.monitor_config = monitor_config or MonitorConfig()

        # Single shared httpx client with connection pooling
        self._http = httpx.AsyncClient(
            headers={"Content-Type": "application/json; charset=utf-8"},
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
            timeout=httpx.Timeout(self.monitor_config.timeout_seconds),
        )
        self._client = AsyncOpenAI(
            api_key=config.api_key,
            base_url=config.api_base,
            http_client=self._http,
        )

    async def chat_completion(
        self,
        messages: List[dict],
        *,
        model: str = None,
        max_tokens: int = 300,
        temperature: float = 0.7,
        stream: bool = False,
        timeout: float = None,
    ) -> Any:
        """Call the LLM with retry logic (2 models × 2 retries).

        Args:
            messages: OpenAI-format message list
            model: Model name (defaults to config.model)
            max_tokens: Max completion tokens
            temperature: Sampling temperature
            stream: Whether to stream the response
            timeout: Per-call timeout (seconds)

        Returns:
            OpenAI chat completion response object

        Raises:
            RuntimeError: After all retries exhausted
        """
        model = model or self.config.model
        timeout = timeout or self.monitor_config.timeout_seconds

        models_to_try = [model, self.monitor_config.fallback_model]
        # Deduplicate
        seen = set()
        unique_models = []
        for m in models_to_try:
            if m and m not in seen:
                seen.add(m)
                unique_models.append(m)

        last_error = None

        for current_model in unique_models:
            for retry in range(2):
                try:
                    response = await asyncio.wait_for(
                        self._client.chat.completions.create(
                            model=current_model,
                            messages=messages,
                            max_tokens=max_tokens,
                            temperature=temperature,
                            stream=stream,
                        ),
                        timeout=timeout,
                    )

                    # Track usage
                    prompt_tokens = 0
                    completion_tokens = 0
                    if hasattr(response, "usage") and response.usage:
                        prompt_tokens = response.usage.prompt_tokens or 0
                        completion_tokens = response.usage.completion_tokens or 0
                    else:
                        total_chars = sum(len(m.get("content", "")) for m in messages)
                        prompt_tokens = total_chars // 4
                        completion_tokens = max_tokens // 4

                    self.monitor.record_usage(
                        model=current_model,
                        prompt_tokens=prompt_tokens,
                        completion_tokens=completion_tokens,
                        success=True,
                    )
                    return response

                except asyncio.TimeoutError as e:
                    last_error = e
                    self.monitor.record_usage(
                        model=current_model, prompt_tokens=0, completion_tokens=0,
                        success=False, error=f"Timeout ({timeout}s)",
                    )
                    if retry == 0:
                        await asyncio.sleep(1)
                        continue
                    else:
                        break  # Move to next model

                except Exception as e:
                    last_error = e
                    self.monitor.record_usage(
                        model=current_model, prompt_tokens=0, completion_tokens=0,
                        success=False, error=str(e)[:200],
                    )
                    if retry == 0:
                        await asyncio.sleep(1)
                        continue
                    else:
                        break

        raise RuntimeError(f"LLM call failed after all retries. Last error: {last_error}")

    async def call_json(
        self,
        prompt: str,
        *,
        max_tokens: int = 300,
        system_prompt: str = "你是一个角色扮演主控（DM）。必须严格按照要求的JSON格式回复。",
        temperature: float = 0.1,
        timeout: float = 30.0,
    ) -> dict:
        """Call the LLM and parse JSON response with 3 attempts.

        Includes fuzzy JSON extraction: strips markdown fences,
        finds first { to last }, handles common LLM formatting quirks.

        Returns empty dict on failure (never raises).
        """
        for attempt in range(3):
            try:
                msgs = [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt + (
                        "\n\n请只返回合法的JSON，不要包含markdown代码块标记或其他文字。"
                        if attempt > 0 else ""
                    )},
                ]
                response = await self.chat_completion(
                    messages=msgs,
                    max_tokens=max_tokens + (100 * attempt),
                    temperature=temperature,
                    timeout=timeout,
                )
                raw = (response.choices[0].message.content or "").strip()

                # Extract JSON from various formats
                if "```json" in raw:
                    raw = raw.split("```json")[1].split("```")[0].strip()
                elif "```" in raw:
                    raw = raw.split("```")[1].split("```")[0].strip()

                # Find first { to last }
                if not raw.startswith("{"):
                    brace_start = raw.find("{")
                    brace_end = raw.rfind("}")
                    if brace_start >= 0 and brace_end > brace_start:
                        raw = raw[brace_start:brace_end + 1]

                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    if attempt < 2:
                        continue
                    return {}

            except asyncio.TimeoutError:
                print(f"[LLM] call_json timeout (attempt {attempt+1}/3)")
                if attempt < 2:
                    await asyncio.sleep(1)
                    continue
                return {}
            except Exception as e:
                print(f"[LLM] call_json error: {type(e).__name__}: {e}")
                if attempt < 2:
                    await asyncio.sleep(1)
                    continue
                return {}
        return {}

    async def close(self) -> None:
        """Close the HTTP client. Call during app shutdown."""
        await self._http.aclose()

    @property
    def model(self) -> str:
        return self.config.model
