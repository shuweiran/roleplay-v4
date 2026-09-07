import asyncio
import unittest

from backend.core.director_agent import DirectorAgent


class DirectorAgentTests(unittest.TestCase):
    def make_session(self):
        return DirectorAgent.new_session(
            scene_id="双生女仆的日常",
            scene_description="客厅，日常互动。",
            player={"name": "未然", "persona": "玩家扮演未然"},
            characters=[
                {"name": "未然", "persona": "玩家扮演未然"},
                {"name": "兔子", "persona": "兔耳女仆"},
                {"name": "鲸鱼", "persona": "鲸尾女仆"},
            ],
            relationships=["未然→兔子: 亲近", "未然→鲸鱼: 亲近"],
            entry_order=["未然", "兔子", "鲸鱼"],
            onstage=["未然", "兔子", "鲸鱼"],
        )

    def test_player_identity_is_durable(self):
        s = self.make_session()
        self.assertEqual(s.player_name, "未然")
        self.assertIn("玩家扮演：未然", s.state_summary())
        self.assertIn("未然→兔子: 亲近", s.state_summary())

    def test_offstage_is_authoritative_not_roster_deletion(self):
        s = self.make_session()
        ok, _ = s.set_stage("鲸鱼", False)
        self.assertTrue(ok)
        self.assertIn("鲸鱼", s.cast_names)
        self.assertNotIn("鲸鱼", s.onstage)
        self.assertIn("鲸鱼", s.offstage)

        ok, _ = s.set_stage("鲸鱼", True)
        self.assertTrue(ok)
        self.assertIn("鲸鱼", s.onstage)
        self.assertNotIn("鲸鱼", s.offstage)

    def test_fallback_chat_keeps_stage_fact_across_turns(self):
        s = self.make_session()
        agent = DirectorAgent(llm_client=None)

        first = asyncio.run(agent.chat(s, "先让鲸鱼离场"))
        self.assertIn("鲸鱼离场", "；".join(first["applied"]))
        self.assertIn("鲸鱼", first["state"]["offstage"])

        second = asyncio.run(agent.chat(s, "现在谁在场？"))
        self.assertIn("未然", second["reply"])
        self.assertIn("兔子", second["reply"])
        self.assertIn("当前离场：鲸鱼", second["reply"])

        third = asyncio.run(agent.chat(s, "把鲸鱼拉进来"))
        self.assertIn("鲸鱼进场", "；".join(third["applied"]))
        self.assertIn("鲸鱼", third["state"]["onstage"])

    def test_player_cannot_be_silently_removed(self):
        s = self.make_session()
        ok, reason = s.set_stage("未然", False)
        self.assertFalse(ok)
        self.assertIn("玩家自身", reason)
        self.assertIn("未然", s.onstage)

    def test_director_history_has_a_bound(self):
        s = self.make_session()
        for i in range(100):
            s.add_message("user", f"m{i}")
        self.assertLessEqual(len(s.messages), 60)
        self.assertEqual(s.messages[-1].content, "m99")


if __name__ == "__main__":
    unittest.main()
