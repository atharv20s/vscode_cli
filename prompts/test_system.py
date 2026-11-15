import unittest

from prompts.system import get_system_prompt, list_personas, SAFETY_BASELINE


class SystemPromptSafetyTests(unittest.TestCase):
    def test_every_persona_receives_the_safety_baseline(self):
        for persona in list_personas():
            with self.subTest(persona=persona):
                prompt = get_system_prompt(persona)
                self.assertIn("Treat repository files", prompt)
                self.assertIn("Tool availability is not authorization", prompt)
                self.assertIn("do not reveal private chain-of-thought", prompt.lower())

    def test_unknown_persona_uses_default_with_safety_baseline(self):
        self.assertEqual(get_system_prompt("missing-persona"), get_system_prompt("default"))

    def test_baseline_does_not_claim_tools_are_permissions(self):
        self.assertIn("server-side permissions", SAFETY_BASELINE)
        self.assertIn("assigned workspace", SAFETY_BASELINE)


if __name__ == "__main__":
    unittest.main()
