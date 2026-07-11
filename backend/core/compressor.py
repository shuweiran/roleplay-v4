"""
Compressor — conversation history compression (v4).

v4 changes: Uses shared LLMClient instead of raw AsyncOpenAI client.
"""

from __future__ import annotations

import json
from typing import List, Optional

from ..models.domain import CompressedChunk
from ..services.llm_client import LLMClient


COMPRESS_PROMPT = """你是一个对话压缩专家。请将以下对话压缩为结构化摘要。

要求：
- 摘要：40字以内，概括核心对话内容和情绪走向
- 关键事件：列出2-3个关键事件或转折点
- 未解决线索：列出0-2个尚未解决的伏笔或问题
- 重要性（0-1）：评估这段对话对整体剧情的重要性

对话内容：
{messages}

请用JSON格式回复，字段：summary, key_events (list), open_loops (list), importance (float)"""

EXTRACT_LOOPS_PROMPT = """请从以下压缩摘要中提取所有尚未解决的线索或伏笔。

压缩摘要：
{chunks}

请列出所有未解决的剧情线索，每行一个。如果都没有，回复"无"。"""


class Compressor:
    """Dialogue history compressor using lightweight LLM calls."""

    def __init__(
        self,
        llm_client: LLMClient = None,
        model: str = "deepseek-v4-flash",
        compression_interval: int = 5,
    ):
        self._llm = llm_client
        self.model = model
        self.compression_interval = compression_interval

    @property
    def client(self):
        """Backward-compatible accessor for Router's legacy code path."""
        return self._llm._client if hasattr(self._llm, '_client') else None

    async def compress(
        self,
        messages: list,
        start_round: int = 0,
        end_round: int = 0,
    ) -> CompressedChunk:
        """Compress a batch of messages into structured summary."""
        if not self._llm or not messages:
            return CompressedChunk(
                chunk_id=f"chunk_{start_round}_{end_round}",
                start_round=start_round, end_round=end_round,
                summary="(无对话)", importance=0.0,
            )

        lines = []
        for m in messages:
            name = m.get("name", m.get("role", "?"))
            content = m.get("content", "")[:200]
            lines.append(f"[{name}]: {content}")

        prompt = COMPRESS_PROMPT.format(messages="\n".join(lines))

        try:
            data = await self._llm.call_json(
                prompt, max_tokens=150,
                system_prompt="你是一个简洁的对话压缩专家。请用JSON格式回复。",
            )
            return CompressedChunk(
                chunk_id=f"chunk_{start_round}_{end_round}",
                start_round=start_round, end_round=end_round,
                summary=data.get("summary", "")[:120],
                key_events=data.get("key_events", [])[:5],
                open_loops=data.get("open_loops", [])[:3],
                importance=min(1.0, max(0.0, float(data.get("importance", 0.5)))),
            )
        except Exception as e:
            return CompressedChunk(
                chunk_id=f"chunk_{start_round}_{end_round}",
                start_round=start_round, end_round=end_round,
                summary=f"{len(messages)}条消息的对话",
                key_events=[], open_loops=[], importance=0.3,
            )

    def get_compressed_context(
        self, chunks: List[CompressedChunk], recent_raw: list,
        max_chunks: int = 5, max_recent: int = 3,
    ) -> str:
        """Build context from compressed chunks + recent raw messages."""
        parts = []
        recent_chunks = chunks[-max_chunks:] if len(chunks) > max_chunks else chunks
        for chunk in recent_chunks:
            parts.append(chunk.context_string)

        if recent_raw:
            parts.append("--- 最近对话 ---")
            for m in recent_raw[-max_recent:]:
                name = m.get("name", m.get("role", "?"))
                content = m.get("content", "")[:150]
                parts.append(f"[{name}]: {content}")

        return "\n".join(parts)

    async def extract_open_loops(self, chunks: List[CompressedChunk]) -> list:
        """Extract unresolved plot threads."""
        if not self._llm or not chunks:
            return []

        existing = []
        for c in chunks:
            existing.extend(c.open_loops)

        if not existing:
            return []

        chunk_texts = [c.context_string for c in chunks[-3:]]
        prompt = EXTRACT_LOOPS_PROMPT.format(chunks="\n---\n".join(chunk_texts))

        try:
            msgs = [
                {"role": "system", "content": "你是一个剧情线索分析师。"},
                {"role": "user", "content": prompt},
            ]
            response = await self._llm.chat_completion(
                messages=msgs, max_tokens=100, temperature=0.1, stream=False,
            )
            raw = (response.choices[0].message.content or "").strip()
            if raw == "无":
                return []
            loops = [line.strip().lstrip("1234567890.- ") for line in raw.split("\n") if line.strip()]
            return loops[:5]
        except Exception:
            return existing[:3]

    def should_compress(self, round_count: int) -> bool:
        return round_count > 0 and round_count % self.compression_interval == 0
