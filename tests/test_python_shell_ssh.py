import unittest
from types import SimpleNamespace

from tools.builtin.shell import (
    _build_remote_payload,
    _resolve_remote_workspace,
    _validate_remote_ssh_config,
)


class RemoteShellBoundaryTests(unittest.TestCase):
    def test_workspace_path_is_confined(self):
        self.assertEqual(
            _resolve_remote_workspace("/srv/workspaces/u1", "src/app"),
            "/srv/workspaces/u1/src/app",
        )
        self.assertEqual(
            _resolve_remote_workspace("/srv/workspaces/u1", "C:\\project\\src"),
            "/srv/workspaces/u1/C:/project/src",
        )
        with self.assertRaisesRegex(ValueError, "outside the configured workspace"):
            _resolve_remote_workspace("/srv/workspaces/u1", "../../etc")
        with self.assertRaisesRegex(ValueError, "outside the configured workspace"):
            _resolve_remote_workspace("/srv/workspaces/u1", "/etc")

    def test_remote_target_validation_rejects_option_injection(self):
        cfg = SimpleNamespace(remote_host="-oProxyCommand=evil", remote_user="ubuntu", remote_port=22)
        with self.assertRaisesRegex(ValueError, "Invalid remote SSH host"):
            _validate_remote_ssh_config(cfg)
        cfg.remote_host = "10.0.0.2"
        cfg.remote_user = "ubuntu;id"
        with self.assertRaisesRegex(ValueError, "Invalid remote SSH username"):
            _validate_remote_ssh_config(cfg)
        cfg.remote_user = "ubuntu"
        cfg.remote_port = 70000
        with self.assertRaisesRegex(ValueError, "SSH port"):
            _validate_remote_ssh_config(cfg)

    def test_remote_payload_quotes_paths_and_validates_container(self):
        payload = _build_remote_payload("npm test", "/srv/workspaces/u1/a b's", "worker-1")
        self.assertIn("docker exec -i worker-1 bash -lc", payload)
        self.assertIn("a b", payload)
        with self.assertRaisesRegex(ValueError, "Invalid Docker container"):
            _build_remote_payload("id", "/workspace", "worker;id")


if __name__ == "__main__":
    unittest.main()