import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { createWorkspaceShare, listWorkspaceShares, revokeWorkspaceShare } from "../services/workspaceCollaborationService.js";

const router = Router();
router.use(requireAuth);

router.post("/shares", async (req, res) => {
  try {
    const share = await createWorkspaceShare({
      ownerUserId: req.user.id,
      workspaceId: req.body?.workspaceId || "default",
      permission: req.body?.permission || "edit",
      expiresInHours: req.body?.expiresInHours ?? 168,
    });
    const base = (process.env.PUBLIC_URL || req.protocol + "://" + req.get("host")).replace(/\/$/, "");
    return res.status(201).json({
      success: true,
      share: { id: share.id, workspaceId: share.workspaceId, permission: share.permission, expiresAt: share.expiresAt },
      url: base + "/#workspace-share=" + encodeURIComponent(share.token),
    });
  } catch (error) {
    return res.status(400).json({ error: "WorkspaceShareCreateFailed", message: error.message });
  }
});

router.get("/shares", async (req, res) => {
  try {
    return res.json({ shares: await listWorkspaceShares(req.user.id, req.query.workspaceId || "default") });
  } catch (error) {
    return res.status(500).json({ error: "WorkspaceShareListFailed", message: error.message });
  }
});

router.delete("/shares/:shareId", async (req, res) => {
  try {
    const revoked = await revokeWorkspaceShare(req.user.id, req.params.shareId);
    return revoked ? res.json({ success: true }) : res.status(404).json({ error: "WorkspaceShareNotFound" });
  } catch (error) {
    return res.status(500).json({ error: "WorkspaceShareRevokeFailed", message: error.message });
  }
});

export default router;
