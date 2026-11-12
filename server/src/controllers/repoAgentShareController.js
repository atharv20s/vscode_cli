import {
  createRepoAgentShare,
  getSharedRepoAgentTask,
  commentOnSharedRepoTask,
  submitSharedRepoInstruction,
  listRepoAgentShares,
  revokeRepoAgentShare,
} from "../services/repoAgentService.js";

export async function createTaskShare(req,res) {
  try {
    const permission = req.body?.permission || "view";
    const expiresInHours = req.body?.expiresInHours === 0 ? 0 : Number(req.body?.expiresInHours || 168);
    const share = await createRepoAgentShare(req.user.id,req.params.taskId,permission,expiresInHours);
    if (!share) return res.status(404).json({error:"TaskNotFound"});
    return res.status(201).json({
      success:true,
      share,
      // The raw bearer token is returned only once to the owner.
      url:(process.env.PUBLIC_URL || req.protocol + "://" + req.get("host")).replace(/\/$/, "") + "/?share=" + encodeURIComponent(share.token),
    });
  } catch(error) {
    return res.status(error.statusCode || 500).json({error:"ShareCreateFailed",message:error.message});
  }
}

export async function listTaskShares(req,res) {
  const shares = await listRepoAgentShares(req.user.id,req.params.taskId);
  if (!shares) return res.status(404).json({error:"TaskNotFound"});
  return res.json({shares});
}

export async function revokeTaskShare(req,res) {
  const revoked = await revokeRepoAgentShare(req.user.id,req.params.shareId);
  if (!revoked) return res.status(404).json({error:"ShareNotFound"});
  return res.json({success:true});
}

export async function getSharedTask(req,res) {
  const result = await getSharedRepoAgentTask(req.params.token);
  if (!result) return res.status(404).json({error:"ShareNotFound",message:"This link is invalid, expired or revoked."});
  return res.json(result);
}

export async function addSharedTaskComment(req,res) {
  try {
    const comment = await commentOnSharedRepoTask(
      req.params.token,
      req.body?.body,
      req.body?.authorLabel
    );
    if (!comment) return res.status(404).json({error:"ShareNotFound"});
    return res.status(201).json({comment});
  } catch(error) {
    return res.status(error.statusCode || 500).json({error:"ShareCommentFailed",message:error.message});
  }
}

export async function submitSharedTaskInstruction(req,res) {
  try {
    const task = await submitSharedRepoInstruction(
      req.params.token,
      req.body?.instruction,
      req.body?.authorLabel
    );
    if (!task) return res.status(404).json({error:"ShareNotFound"});
    return res.status(202).json({success:true,task});
  } catch(error) {
    return res.status(error.statusCode || 500).json({error:"SharedInstructionFailed",message:error.message});
  }
}
