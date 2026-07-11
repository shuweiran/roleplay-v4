"""Local Whisper speech-to-text service.
Uses the cached whisper model for completely offline, free transcription."""

import os
import whisper
import tempfile
from typing import Optional


_model = None


def get_model(model_name: str = "base") -> whisper.Whisper:
    global _model
    if _model is None:
        print(f"[Whisper] Loading model: {model_name}")
        _model = whisper.load_model(model_name)
        print(f"[Whisper] Model loaded: {model_name}")
    return _model


async def transcribe_audio(audio_bytes: bytes, language: str = "zh") -> str:
    """Transcribe audio bytes to text using local Whisper model.
    
    Args:
        audio_bytes: Raw audio file bytes (wav, mp3, etc.)
        language: Language code (zh, en, etc.)
        
    Returns:
        Transcribed text string
    """
    model = get_model("base")
    
    # Write bytes to temp file (whisper reads from file path)
    suffix = ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name
    
    try:
        result = model.transcribe(tmp_path, language=language, fp16=False)
        return result["text"].strip()
    finally:
        try:
            os.unlink(tmp_path)
        except:
            pass


def unload_model():
    """Free the model from memory."""
    global _model
    _model = None
    import gc
    gc.collect()
