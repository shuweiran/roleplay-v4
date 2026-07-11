"""SSE event stream route."""

from __future__ import annotations

import asyncio
import json
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api", tags=["sse"])

_active_connections: dict[str, asyncio.Queue] = {}
_connection_namespace: dict[str, str] = {}


@router.get("/events")
async def event_stream(request: Request):
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    cid = str(uuid.uuid4())[:8]
    _active_connections[cid] = queue
    # Store namespace per connection for isolation
    from ..services.namespace import GLOBAL_NS
    _connection_namespace[cid] = getattr(request.state, 'namespace', GLOBAL_NS)

    async def generator():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    sse_data = json.dumps(event["data"], ensure_ascii=False)
                    yield f"event: {event['event_type']}\ndata: {sse_data}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            _active_connections.pop(cid, None)
            _connection_namespace.pop(cid, None)

    return StreamingResponse(generator(), media_type="text/event-stream",
                              headers={"Cache-Control": "no-cache",
                                       "X-Accel-Buffering": "no"})


# Hook for Router to broadcast events to all SSE connections
# Router._emit() passes MessageEvent objects, so we accept either form
def broadcast_event(event_or_type, data=None):
    if hasattr(event_or_type, 'event_type'):
        # Called as cb(MessageEvent)
        event_type, data = event_or_type.event_type, event_or_type.data
    else:
        # Called as cb(event_type, data)
        event_type = event_or_type
    
    # Extract namespace from event data for isolation
    ns = (data or {}).get('_ns', 'global')
    
    for cid, queue in list(_active_connections.items()):
        conn_ns = _connection_namespace.get(cid, 'global')
        if conn_ns != ns:
            continue  # Skip connections from other namespaces
        try:
            queue.put_nowait({"event_type": event_type, "data": data})
        except asyncio.QueueFull:
            pass
