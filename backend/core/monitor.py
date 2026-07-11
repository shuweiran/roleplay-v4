"""
Monitor — error recovery and cost monitoring for the roleplay system.

Provides:
- Per-call token/cost tracking
- Budget enforcement (warn when approaching limit)
- Cost estimation for planning
- Retry logic with model fallback
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional, Tuple


# Cost per 1M tokens (approximate USD rates)
# Using a dict for easy extensibility
MODEL_COST_PER_MTOKENS: Dict[str, Tuple[float, float]] = {
    # model: (input_cost_per_1M, output_cost_per_1M)
    "deepseek/deepseek-v4-flash": (0.15, 0.60),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-3.5-turbo": (0.50, 1.50),
    "claude-3-haiku": (0.25, 1.25),
    "claude-3-sonnet": (3.00, 15.00),
    # Fallback default if model not in table
}

# Default fallback model when primary fails
DEFAULT_FALLBACK_MODEL = "deepseek/deepseek-v4-flash"


@dataclass
class UsageRecord:
    """A single LLM usage record."""
    model: str
    prompt_tokens: int
    completion_tokens: int
    timestamp: float = field(default_factory=time.time)
    success: bool = True
    error: Optional[str] = None

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def calculate_cost(self) -> float:
        """Calculate cost in USD for this call."""
        rates = MODEL_COST_PER_MTOKENS.get(
            self.model,
            (0.15, 0.60),  # Default fallback rate
        )
        input_cost = (self.prompt_tokens / 1_000_000) * rates[0]
        output_cost = (self.completion_tokens / 1_000_000) * rates[1]
        return input_cost + output_cost


class Monitor:
    """
    Tracks LLM usage, costs, and provides retry/fallback logic.

    Usage:
        monitor = Monitor(budget=10.0)
        monitor.record_usage("deepseek/deepseek-v4-flash", 500, 200)
        report = monitor.get_cost_report()
        cost_est = monitor.estimate_conversation_cost(turns=20)
    """

    def __init__(self, budget: float = 10.0):
        self.budget = budget
        self.records: List[UsageRecord] = []
        self._total_tokens: int = 0
        self._total_cost: float = 0.0
        # Keep sliding window of recent costs for estimation
        self._recent_costs: Deque[float] = deque(maxlen=50)

    def record_usage(
        self,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
        success: bool = True,
        error: Optional[str] = None,
    ) -> float:
        """
        Record an LLM usage event.

        Args:
            model: Model name used
            prompt_tokens: Input token count
            completion_tokens: Output token count
            success: Whether the call succeeded
            error: Error message if failed

        Returns:
            Cost in USD for this call.
        """
        record = UsageRecord(
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            success=success,
            error=error,
        )
        cost = record.calculate_cost()

        self.records.append(record)
        self._total_tokens += record.total_tokens
        self._total_cost += cost
        self._recent_costs.append(cost)

        return cost

    def get_cost_report(self) -> dict:
        """
        Generate a comprehensive cost report.

        Returns:
            dict with total_tokens, total_cost, estimated_remaining,
            avg_cost_per_call, recent_avg_per_call, call_count.
        """
        total_calls = len(self.records)
        successful_calls = sum(1 for r in self.records if r.success)

        avg_cost = 0.0
        if total_calls > 0:
            avg_cost = self._total_cost / total_calls

        recent_avg = 0.0
        if self._recent_costs:
            recent_avg = sum(self._recent_costs) / len(self._recent_costs)

        remaining = max(0.0, self.budget - self._total_cost)

        return {
            "total_tokens": self._total_tokens,
            "total_cost_usd": round(self._total_cost, 6),
            "budget_usd": self.budget,
            "estimated_remaining_usd": round(remaining, 6),
            "budget_used_pct": round(
                (self._total_cost / self.budget * 100) if self.budget > 0 else 0,
                2,
            ),
            "total_calls": total_calls,
            "successful_calls": successful_calls,
            "failed_calls": total_calls - successful_calls,
            "avg_cost_per_call_usd": round(avg_cost, 6),
            "recent_avg_cost_per_call_usd": round(recent_avg, 6),
        }

    def estimate_conversation_cost(self, turns: int) -> float:
        """
        Estimate the cost of N conversation turns based on historical averages.

        Uses a sliding window of recent costs for estimation. If no history
        exists, uses a rough default.

        Args:
            turns: Number of conversation turns to estimate

        Returns:
            Estimated cost in USD.
        """
        if not self._recent_costs:
            # Rough default: ~$0.003 per turn (2 agent calls)
            return turns * 0.003

        avg_per_call = sum(self._recent_costs) / len(self._recent_costs)
        # Each turn involves ~2 LLM calls (one per agent)
        return avg_per_call * 2 * turns

    def get_usage_summary(self, last_n: int = 10) -> List[dict]:
        """Get the last N usage records as dicts."""
        records = self.records[-last_n:] if self.records else []
        return [
            {
                "model": r.model,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "total_tokens": r.total_tokens,
                "cost": round(r.calculate_cost(), 6),
                "success": r.success,
                "error": r.error,
                "timestamp": r.timestamp,
            }
            for r in records
        ]

    @property
    def total_tokens(self) -> int:
        return self._total_tokens

    @property
    def total_cost(self) -> float:
        return self._total_cost

    @property
    def is_budget_exhausted(self) -> bool:
        """Check if the budget has been exceeded."""
        return self._total_cost >= self.budget

    @property
    def budget_remaining(self) -> float:
        """Return remaining budget."""
        return max(0.0, self.budget - self._total_cost)
