"""
Voice Loop routes — production integration with V4 multi-agent system.
Mic -> faster-whisper ASR -> V4 agent system -> CosyVoice TTS -> Speaker.
With echo cancellation (NCC) + barge-in + streaming TTS pipeline.
"""

import asyncio, json, os, logging, time
import numpy as np
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger("voice")

router = APIRouter(prefix="/api/voice", tags=["voice"])

# ── Global state ──
_voice_task: Optional[asyncio.Task] = None
_voice_running = False
_voice_state = "idle"  # idle | listening | processing | speaking


class VoiceStatus(BaseModel):
    running: bool = False
    state: str = "idle"


# ── Import voice loop modules (lazy) ──
_imported = False


def _import_voice_modules():
    global _imported, ASREngine, CosyVoiceEngine, AudioIO, StreamingSpeaker
    global EchoCanceller, split_sentences
    if _imported:
        return
    import sys
    voice_dir = os.path.join(os.path.dirname(__file__), "..", "..", "..", "voice_loop")
    voice_dir = os.path.abspath(voice_dir)
    if voice_dir not in sys.path:
        sys.path.insert(0, os.path.dirname(voice_dir))

    from voice_loop.asr import ASREngine
    from voice_loop.tts import CosyVoiceEngine
    from voice_loop.audio import AudioIO, EchoCanceller
    from voice_loop.voice_loop_service import StreamingSpeaker, split_sentences
    _imported = True
    logger.info("Voice loop modules imported")


# ── Config ──
COSYVOICE_VOICE = "cosyvoice-v3.5-flash-weiling35-317f7e14790349a297edb1602bbaa925"
COSYVOICE_MODEL = "cosyvoice-v3.5-flash"


def _read_dashscope_key() -> str:
    key_file = os.path.expanduser("~/.dashscope_api_key")
    if os.path.exists(key_file):
        with open(key_file) as f:
            return f.read().strip()
    return ""


# ── Core: send user text to V4 internally ──

async def _send_to_v4(text: str, request: Request) -> Optional[str]:
    """Send user text to V4 multi-agent system. Collects agent outputs from turn events."""
    try:
        from ..routes_session import get_router
        from ..core.router import TurnPhase
    except ImportError:
        return None

    r = getattr(request.app.state, "router", None)
    if not r:
        return None

    reply_parts = []

    r.phase = TurnPhase.RUNNING
    try:
        async for event in r.handle_user_input(text, player_name="me"):
            if event.event_type == "agent_output":
                name = event.data.get("name", "")
                content = event.data.get("content", "")
                if content:
                    reply_parts.append(f"{name}: {content}" if name else content)
            elif event.event_type == "round_complete":
                narration = event.data.get("narration", "")
                if narration:
                    reply_parts.append(narration)
            await r._emit(event.event_type, event.data)
    except Exception as e:
        logger.error(f"V4 handle error: {e}")
        return None
    finally:
        r.phase = TurnPhase.IDLE

    if reply_parts:
        return "\n".join(reply_parts)
    return None


# ── Voice loop main (production-grade) ──

async def voice_loop_main(request: Request):
    """Voice loop main: mic -> ASR -> V4 -> TTS -> speaker.
    Uses the production voice_loop_service components."""
    global _voice_running, _voice_state

    api_key = _read_dashscope_key()
    if not api_key:
        logger.error("DashScope API Key not found at ~/.dashscope_api_key")
        _voice_running = False
        _voice_state = "idle"
        return

    _import_voice_modules()

    # ── Init engines ──
    from voice_loop.config import config
    asr_engine = ASREngine(model_name="small", device="cpu", compute_type="int8")
    await asr_engine._load_model()
    tts = CosyVoiceEngine(voice=COSYVOICE_VOICE, model=COSYVOICE_MODEL, api_key=api_key)
    audio = AudioIO()
    await audio.start()
    speaker = StreamingSpeaker(audio, audio.echo_canceller)

    # Pre-warm
    await tts.synthesize("hi")

    _voice_running = True
    _voice_state = "listening"
    logger.info("Voice loop started! Speak into the mic...")

    try:
        while _voice_running:
            # ── Phase A: Record + VAD + ASR ──
            _voice_state = "listening"
            audio_data = await audio.input.read_until_silence(
                min_duration=config.min_audio_length,
                max_duration=config.max_audio_length,
                silence_duration=config.silence_duration,
            )
            if audio_data is None or len(audio_data) < int(config.sample_rate * 0.3):
                continue
            if np.abs(audio_data).max() < config.silence_threshold:
                continue

            _voice_state = "processing"
            result = await asr_engine.transcribe(audio_data, config.sample_rate)
            user_text = result.text if result else ""
            if not user_text:
                continue
            logger.info(f"[You] {user_text}")

            # ── Phase B: Send to V4 agent system ──
            try:
                reply = await _send_to_v4(user_text, request)
            except Exception as e:
                logger.error(f"V4 send error: {e}")
                continue

            if not reply:
                logger.info("No reply from V4")
                continue

            logger.info(f"[V4] {reply[:100]}...")

            # ── Phase C: TTS + Play ──
            _voice_state = "speaking"
            sentences = split_sentences(reply)
            if sentences:
                await speaker.play_stream(tts, sentences)

            # Post-playback cooldown
            if audio.input:
                await audio.input.drain(duration_sec=0.3)

    except asyncio.CancelledError:
        logger.info("Voice loop cancelled")
    except Exception as e:
        logger.error(f"Voice loop error: {e}", exc_info=True)
    finally:
        _voice_running = False
        _voice_state = "idle"
        await tts.close()
        await asr_engine.close()
        await audio.stop()
        logger.info("Voice loop stopped")


# ── API endpoints ──

@router.get("/status", response_model=VoiceStatus)
async def get_status():
    return VoiceStatus(running=_voice_running, state=_voice_state)


@router.post("/start")
async def start_voice(request: Request):
    global _voice_task, _voice_running
    if _voice_running:
        raise HTTPException(409, "Voice loop already running")
    _voice_task = asyncio.create_task(voice_loop_main(request))
    return {"status": "ok", "message": "Voice loop started"}


@router.post("/stop")
async def stop_voice():
    global _voice_task, _voice_running, _voice_state
    _voice_running = False
    _voice_state = "idle"
    if _voice_task and not _voice_task.done():
        _voice_task.cancel()
        _voice_task = None
    return {"status": "ok", "message": "Voice loop stopped"}
