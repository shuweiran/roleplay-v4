"""
TTS Service — 语音合成服务
主后端：Edge TTS（微软，低延迟真流式）
备选：千问 CosyVoice（DashScope）
支持流式和非流式输出。
"""

import asyncio
import logging
import os
from typing import AsyncGenerator, Optional

logger = logging.getLogger("tts")

COSYVOICE_VOICE = "cosyvoice-v3.5-flash-weiling35-317f7e14790349a297edb1602bbaa925"
COSYVOICE_MODEL = "cosyvoice-v3.5-flash"

EDGE_VOICE_MAP = {
    "zh": "zh-CN-XiaoxiaoNeural",
    "en": "en-US-AriaNeural",
    "jp": "ja-JP-NanamiNeural",
    "kr": "ko-KR-SunHiNeural",
}


def _read_dashscope_key() -> str:
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if key:
        return key
    key_file = os.path.expanduser("~/.dashscope_api_key")
    if os.path.exists(key_file):
        with open(key_file) as f:
            return f.read().strip()
    return ""


async def stream_tts(
    text: str,
    lang: str = "zh",
    voice: Optional[str] = None,
    backend: str = "auto",
) -> AsyncGenerator[bytes, None]:
    """
    流式 TTS，逐 chunk 产出 MP3 音频数据。
    
    Args:
        text: 要朗读的文本
        lang: 语言
        voice: 音色
        backend: "edge" | "cosyvoice" | "auto"
            - edge: Edge TTS，低延迟真流式，适合快速对话（首选）
            - cosyvoice: 千问 CosyVoice，高音质，适合叙述（备选）
            - auto: Edge TTS 优先，失败回退 CosyVoice
    """
    if not text or not text.strip():
        return

    if backend == "edge":
        async for chunk in _edge_stream(text, lang):
            yield chunk
        return

    if backend == "cosyvoice":
        api_key = _read_dashscope_key()
        if api_key:
            async for chunk in _cosyvoice_stream(text, voice or COSYVOICE_VOICE, api_key):
                yield chunk
        else:
            logger.warning("CosyVoice 需要 DashScope API Key，回退 edge-tts")
            async for chunk in _edge_stream(text, lang):
                yield chunk
        return

    # auto: Edge TTS 优先（低延迟真流式），失败回退 CosyVoice
    try:
        async for chunk in _edge_stream(text, lang):
            yield chunk
    except Exception as e:
        logger.warning(f"Edge TTS 失败 ({e})，回退 CosyVoice")
        api_key = _read_dashscope_key()
        if api_key:
            async for chunk in _cosyvoice_stream(text, voice or COSYVOICE_VOICE, api_key):
                yield chunk
        else:
            logger.warning("CosyVoice 需要 DashScope API Key，无法回退")


async def _cosyvoice_stream(
    text: str,
    voice: str,
    api_key: str,
) -> AsyncGenerator[bytes, None]:
    """CosyVoice 合成（非流式调用，结果分批输出模拟流式）"""
    try:
        os.environ["DASHSCOPE_API_KEY"] = api_key
        from dashscope.audio.tts_v2 import SpeechSynthesizer, AudioFormat

        def _synth() -> bytes:
            synthesizer = SpeechSynthesizer(
                model=COSYVOICE_MODEL,
                voice=voice,
                format=AudioFormat.MP3_22050HZ_MONO_256KBPS,
            )
            result = synthesizer.call(text)
            if isinstance(result, bytes):
                return result
            return b""

        loop = asyncio.get_event_loop()
        audio = await asyncio.wait_for(
            loop.run_in_executor(None, _synth),
            timeout=30,
        )

        if audio:
            # 按 8KB 分块输出，模拟流式效果
            chunk_size = 8192
            for i in range(0, len(audio), chunk_size):
                yield audio[i:i + chunk_size]

    except ImportError:
        logger.warning("dashscope SDK 未安装，回退 edge-tts")
        async for chunk in _edge_stream(text, "zh"):
            yield chunk
    except asyncio.TimeoutError:
        logger.warning("CosyVoice 超时，回退 edge-tts")
        async for chunk in _edge_stream(text, "zh"):
            yield chunk
    except Exception as e:
        logger.warning(f"CosyVoice 失败 ({e})，回退 edge-tts")
        async for chunk in _edge_stream(text, "zh"):
            yield chunk


async def _edge_stream(
    text: str,
    lang: str = "zh",
) -> AsyncGenerator[bytes, None]:
    """Edge TTS 流式合成（备用）"""
    try:
        import edge_tts
        voice = EDGE_VOICE_MAP.get(lang, EDGE_VOICE_MAP["zh"])
        communicate = edge_tts.Communicate(text, voice)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]
    except Exception as e:
        logger.error(f"Edge TTS 也失败了: {e}")
