"""
Lorebook — keyword-triggered world knowledge injection system.

Allows the DM / system to define "lore entries" that are automatically
injected into an agent's context when relevant keywords appear in the
recent conversation.

Inspired by the AI Dungeon / KoboldAI lorebook pattern.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import yaml


@dataclass
class LoreEntry:
    """
    A single lorebook entry with keyword triggers.

    Attributes:
        keywords: List of trigger keywords (matched against recent context)
        content: The knowledge text to inject
        weight: Priority (positive = preferred injection, negative = avoid)
        category: Classification (人物/地点/物品/事件/场景/人物背景)
    """
    keywords: List[str]
    content: str
    weight: int = 0
    category: str = ""

    def to_dict(self) -> dict:
        return {
            "keywords": self.keywords,
            "content": self.content,
            "weight": self.weight,
            "category": self.category,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "LoreEntry":
        return cls(
            keywords=data.get("keywords", []),
            content=data.get("content", ""),
            weight=data.get("weight", 0),
            category=data.get("category", ""),
        )


class Lorebook:
    """
    Lorebook manager — loads, stores, and retrieves lore entries based on
    keyword matching against conversation context.

    Usage:
        lorebook = Lorebook()
        lorebook.add_entry(LoreEntry(
            keywords=["夜", "深夜"],
            content="林诗长期失眠...",
            weight=2,
            category="人物背景",
        ))
        entries = lorebook.get_active_entries("林诗在深夜思考", max_tokens=500)
    """

    def __init__(self):
        self.entries: List[LoreEntry] = []

    def add_entry(self, entry: LoreEntry) -> None:
        """Add a single lore entry."""
        self.entries.append(entry)

    def add_entries(self, entries: List[LoreEntry]) -> None:
        """Add multiple lore entries at once."""
        self.entries.extend(entries)

    def remove_entry(self, entry: LoreEntry) -> None:
        """Remove a specific lore entry."""
        if entry in self.entries:
            self.entries.remove(entry)

    def clear(self) -> None:
        """Remove all lore entries."""
        self.entries.clear()

    def load_from_yaml(self, path: str) -> int:
        """
        Load lore entries from a YAML file.

        Expected format:
            lore:
              - keywords: ["夜", "深夜"]
                content: "..."
                weight: 2
                category: "人物背景"
              - ...

        Args:
            path: Path to YAML file

        Returns:
            Number of entries loaded.
        """
        if not os.path.exists(path):
            raise FileNotFoundError(f"Lorebook YAML not found: {path}")

        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)

        if not data or "lore" not in data:
            return 0

        loaded = 0
        for item in data["lore"]:
            entry = LoreEntry.from_dict(item)
            self.add_entry(entry)
            loaded += 1

        return loaded

    @classmethod
    def calculate_lore_budget(cls, used_tokens: int, total_budget: int = 4000) -> int:
        """动态计算 lore 可用 token 预算。

        根据已使用的 token 和总预算，按比例计算 lore 注入的 token 上限。
        当上下文空间紧张时自动降低 lore 占用比例。

        Args:
            used_tokens: 已使用的 token 数（system prompt + history + summary）
            total_budget: 总 token 预算，默认 4000

        Returns:
            lore 可用的最大 token 数
        """
        remaining = total_budget - used_tokens
        if remaining < 500:
            # 上下文空间严重不足，最多占 10%，不低于 50
            return max(50, int(remaining * 0.1))
        # 最多占 30%，上限 500
        return min(int(remaining * 0.3), 500)

    def has_any_match(self, context: str) -> bool:
        """零 token 成本的快速关键词匹配。

        在第一轮检索中使用，只做简单的子串匹配，
        不做任何排序或截断，快速判断是否有 lore 需要注入。
        仅当返回 True 时才执行完整的 get_active_entries()。

        Args:
            context: 待匹配的上下文文本

        Returns:
            是否有任何关键词命中
        """
        lower_context = context.lower()
        for entry in self.entries:
            for kw in entry.keywords:
                if kw.lower() in lower_context:
                    return True
        return False

    def _extract_keywords_from_context(self, context: str) -> Set[str]:
        """
        Extract matched keywords from context text.

        Performs simple substring matching against all registered keywords.
        Also handles Chinese word boundary approximation (any match counts).
        """
        matched: Set[str] = set()
        lower_context = context.lower()

        for entry in self.entries:
            for keyword in entry.keywords:
                if keyword.lower() in lower_context:
                    matched.add(keyword)

        return matched

    def get_active_entries(
        self,
        context: str,
        max_tokens: int = 500,
        dynamic_max_tokens: bool = False,
        used_tokens: int = 0,
        total_budget: int = 4000,
    ) -> List[LoreEntry]:
        """
        Get lore entries whose keywords appear in the given context.

        支持两级检索：先调用 has_any_match() 做零成本关键词粗筛，
        命中后再执行完整的权重排序和截断。

        Results are sorted by weight (highest first). Entries with negative
        weight are excluded (they act as anti-triggers).

        Args:
            context: Text to search for keyword matches (recent conversation)
            max_tokens: Maximum total content length (in characters ≈ tokens)
            dynamic_max_tokens: 是否使用动态 token 预算
            used_tokens: 已使用的 token 数（dynamic_max_tokens=True 时需要）
            total_budget: 总 token 预算（dynamic_max_tokens=True 时需要）

        Returns:
            List of matching LoreEntry objects (sorted by weight desc).
        """
        # 两级检索：先做零成本的快速关键词匹配
        if not self.has_any_match(context):
            return []

        # 动态计算 token 预算
        effective_max_tokens = max_tokens
        if dynamic_max_tokens:
            effective_max_tokens = self.calculate_lore_budget(used_tokens, total_budget)

        matched_keywords = self._extract_keywords_from_context(context)

        if not matched_keywords:
            return []

        # Find entries that have at least one matching keyword
        matched_entries: List[Tuple[LoreEntry, int]] = []
        for entry in self.entries:
            if entry.weight < 0:
                continue  # Negative weight = avoid
            match_count = sum(1 for kw in entry.keywords if kw in matched_keywords)
            if match_count > 0:
                matched_entries.append((entry, match_count))

        # Sort by weight (desc), then by match count (desc)
        matched_entries.sort(key=lambda x: (-x[0].weight, -x[1]))

        # Collect results respecting max_tokens
        result: List[LoreEntry] = []
        total_chars = 0
        for entry, _ in matched_entries:
            entry_len = len(entry.content)
            if total_chars + entry_len > effective_max_tokens:
                # Truncate if needed, or skip
                remaining = effective_max_tokens - total_chars
                if remaining > 20:
                    # Create a truncated version
                    truncated = LoreEntry(
                        keywords=entry.keywords,
                        content=entry.content[:remaining] + "...",
                        weight=entry.weight,
                        category=entry.category,
                    )
                    result.append(truncated)
                    total_chars += remaining
                break
            result.append(entry)
            total_chars += entry_len

        return result

    def get_all_entries(self) -> List[LoreEntry]:
        """Return all registered lore entries."""
        return self.entries.copy()

    def get_entries_by_category(self, category: str) -> List[LoreEntry]:
        """Get all entries of a given category."""
        return [e for e in self.entries if e.category == category]

    def get_stats(self) -> dict:
        """Get statistics about the lorebook."""
        categories: Dict[str, int] = {}
        for entry in self.entries:
            cat = entry.category or "uncategorized"
            categories[cat] = categories.get(cat, 0) + 1

        return {
            "total_entries": len(self.entries),
            "categories": categories,
            "total_keywords": sum(len(e.keywords) for e in self.entries),
        }
