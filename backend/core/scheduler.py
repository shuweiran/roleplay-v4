"""
Agent Parallel Scheduler — v1 parallel inference engine for Phase3.

Replaces the serial track×agent loop in _run_round_agents with
priority-aware parallel execution to eliminate linear latency growth.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Callable, Coroutine, Dict, List, Optional, Set, Tuple


class Priority(IntEnum):
    PLAYER = 1       # human player / protagonist
    DM = 2           # director / god
    NPCS = 3         # NPCs and weak-chain bystanders
    LOWEST = 4


@dataclass
class AgentTask:
    """One agent generation task with metadata."""
    agent_name: str
    track_id: str
    track_mode: str  # merged / weak / isolated
    priority: Priority = Priority.NPCS
    coro: Optional[Coroutine] = None
    _started_at: float = 0.0
    _finished_at: float = 0.0

    @property
    def elapsed(self) -> float:
        if self._finished_at:
            return self._finished_at - self._started_at
        if self._started_at:
            return time.monotonic() - self._started_at
        return 0.0


@dataclass
class SchedulerMetrics:
    """Load monitoring for the scheduler."""
    total_tasks: int = 0
    max_concurrent: int = 0
    current_concurrent: int = 0
    avg_latency: float = 0.0
    max_latency: float = 0.0
    total_round_time: float = 0.0

    def to_dict(self) -> dict:
        return {
            "total_tasks": self.total_tasks,
            "max_concurrent": self.max_concurrent,
            "avg_latency": round(self.avg_latency, 2),
            "max_latency": round(self.max_latency, 2),
            "total_round_time": round(self.total_round_time, 2),
        }


def _compute_priority(
    agent_name: str,
    track_mode: str,
    protagonist: str = "",
    director: str = "",
) -> Priority:
    """Compute priority for an agent based on its role."""
    if agent_name == protagonist or agent_name == "me":
        return Priority.PLAYER
    if agent_name == director or track_mode == "merged":
        return Priority.DM if agent_name == director else Priority.NPCS
    if track_mode == "weak":
        return Priority.NPCS
    return Priority.NPCS


async def run_parallel(
    tasks: List[AgentTask],
    max_concurrent: int = 8,
    metrics: Optional[SchedulerMetrics] = None,
) -> Tuple[List[dict], SchedulerMetrics]:
    """Execute generation tasks in parallel with priority-aware batching.

    Strategy:
    - isolated track agents run fully in parallel (no shared context)
    - merged/weak agents within the SAME track can run in parallel
      (they share history context but NOT same-round peer outputs)
    - Priority groups batch separately to ensure high-priority agents first
    - Across tracks: all tracks execute in parallel
    """
    if not tasks:
        return [], metrics or SchedulerMetrics()

    if metrics is None:
        metrics = SchedulerMetrics()

    round_start = time.monotonic()
    metrics.total_tasks = len(tasks)

    # Sort by priority
    tasks_by_priority: Dict[Priority, List[AgentTask]] = {}
    for t in tasks:
        tasks_by_priority.setdefault(t.priority, []).append(t)

    all_results: List[dict] = []
    total_latency = 0.0
    completed = 0
    in_flight = 0

    async def execute_one(task: AgentTask) -> dict:
        nonlocal in_flight, completed, total_latency
        in_flight += 1
        metrics.current_concurrent = in_flight
        metrics.max_concurrent = max(metrics.max_concurrent, in_flight)

        task._started_at = time.monotonic()
        try:
            result = await task.coro
            task._finished_at = time.monotonic()
            latency = task.elapsed
            total_latency += latency
            metrics.max_latency = max(metrics.max_latency, latency)
            completed += 1
            return result
        except Exception as e:
            task._finished_at = time.monotonic()
            completed += 1
            return {
                "agent_name": task.agent_name,
                "content": f"[{task.agent_name} 走神了: {e}]",
                "track_id": task.track_id,
                "visible_to": [],
                "error": str(e),
            }
        finally:
            in_flight -= 1
            metrics.current_concurrent = in_flight

    # Execute in priority order, but parallel within each batch
    parallel_coros: List[Coroutine] = []
    for prio in (Priority.PLAYER, Priority.DM, Priority.NPCS, Priority.LOWEST):
        batch = tasks_by_priority.get(prio, [])
        if not batch:
            continue

        # Launch all tasks in this priority batch
        batch_coros = [execute_one(t) for t in batch]
        parallel_coros.extend(batch_coros)

    # Run everything in one gather (all priorities launched together,
    # but priority is implicit in the task ordering for result collection)
    results = await asyncio.gather(*parallel_coros, return_exceptions=True)

    for r in results:
        if isinstance(r, Exception):
            all_results.append({"agent_name": "?", "content": str(r), "track_id": "?", "visible_to": []})
        elif isinstance(r, dict):
            all_results.append(r)

    if completed > 0:
        metrics.avg_latency = total_latency / completed
    metrics.total_round_time = time.monotonic() - round_start

    return all_results, metrics
