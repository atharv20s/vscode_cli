import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/env.js";
import { logger } from "../config/logger.js";
import {
  generateToken,
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  verifyRefreshToken,
} from "../middleware/auth.js";
import {
  findUserByGithubId,
  findUserById,
  findUserByUsername,
  findUserByEmail,
  createUser,
  createSession,
  updateUserToken,
  updateUserProfile,
} from "../db/database.js";
import { migrateGuestRecords } from "../db/postgres.js";

/**
 * POST /api/auth/guest — Auto-provision or resume persistent guest user identity with JWT.
 */
export async function guestAuth(req, res) {
  try {
    let { guestId } = req.body || {};
    if (!guestId || typeof guestId !== "string") {
      guestId = `gst_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
    } else {
      guestId = guestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    }

    const userId = `usr_${guestId}`;
    const sessionId = `sess_${guestId}`;
    const username = `guest_${guestId.slice(-4)}`;
    const email = `${guestId}@local.studio`;

    let user = findUserById(userId);
    if (!user) {
      createUser({
        id: userId,
        username,
        email,
        avatarUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${guestId}`,
      });
      user = findUserById(userId);
    }

    // Ensure session exists in SQLite
    try {
      createSession({
        id: sessionId,
        userId: user.id,
        workspacePath: config.workspaceRoot,
      });
    } catch {}

    const userPayload = {
      id: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatar_url,
      sessionId,
      isGuest: true,
    };
    const tokens = generateTokenPair(userPayload);

    res.json({
      success: true,
      token: tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      guestId,
      user: userPayload,
    });
  } catch (err) {
    logger.error("Guest auth error", { error: err.message });
    res.status(500).json({ error: "AuthError", message: err.message });
  }
}

/**
 * Hash password securely using scrypt with salt.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

/**
 * Verify password against stored hash.
 */
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, key] = storedHash.split(":");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(key, "hex"), derivedKey);
}

/**
 * POST /api/auth/register — User Sign Up (Email, Password).
 */
export async function register(req, res) {
  const { email, username, password } = req.body;
  const rawEmail = (email || username || "").trim();

  if (!rawEmail) {
    return res.status(400).json({ error: "BadRequest", message: "Please provide an email address." });
  }

  if (!password || typeof password !== "string" || !password.trim()) {
    return res.status(400).json({ error: "BadRequest", message: "Please provide a password." });
  }

  const cleanEmail = rawEmail.toLowerCase();
  const cleanUsername = cleanEmail.includes("@") ? cleanEmail.split("@")[0] : cleanEmail;

  // Check if email or username already taken
  const existingEmail = findUserByEmail(cleanEmail);
  if (existingEmail) {
    return res.status(409).json({ error: "UserExists", message: "An account with this email already exists. Please Sign In." });
  }

  const existingUser = findUserByUsername(cleanUsername);
  const finalUsername = existingUser ? `${cleanUsername}_${Date.now().toString().slice(-4)}` : cleanUsername;

  const userId = `usr_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const passwordHash = hashPassword(password);

  createUser({
    id: userId,
    username: finalUsername,
    email: cleanEmail,
    passwordHash,
    avatarUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${cleanUsername}`,
  });

  const newUser = findUserById(userId);
  const userPayload = {
    id: newUser.id,
    username: newUser.username,
    email: newUser.email,
    avatarUrl: newUser.avatar_url,
    hasGithub: false,
  };
  const tokens = generateTokenPair(userPayload);

  // Migrate any active guest data to this newly registered user
  const guestId = req.body.guestId;
  if (guestId) {
    migrateGuestRecords(`usr_${guestId}`, newUser.id).catch(() => {});
  }

  logger.info(`User registered with email: ${cleanEmail}`, { userId });

  res.status(201).json({
    success: true,
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    user: userPayload,
  });
}

/**
 * POST /api/auth/login — User Sign In (Email and Password).
 */
export async function login(req, res) {
  const { email, username, password, guestId } = req.body;
  const identifier = (email || username || "").trim();

  if (!identifier || !password) {
    return res.status(400).json({ error: "BadRequest", message: "Email and password are required." });
  }

  const user = findUserByEmail(identifier.toLowerCase()) || findUserByUsername(identifier);

  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "AuthFailed", message: "Invalid email or password." });
  }

  // Migrate any active guest data to this user
  if (guestId) {
    migrateGuestRecords(`usr_${guestId}`, user.id).catch(() => {});
  }

  const userPayload = {
    id: user.id,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatar_url,
    githubAccessToken: user.github_access_token,
    hasGithub: Boolean(user.github_access_token),
  };
  const tokens = generateTokenPair(userPayload);

  logger.info(`User logged in: ${user.email || user.username}`, { userId: user.id });

  res.json({
    success: true,
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    githubToken: user.github_access_token,
    user: userPayload,
  });
}

/**
 * POST /api/auth/refresh — Exchange refresh token for a new access token.
 */
export async function refreshAccessToken(req, res) {
  const refreshToken = req.body?.refreshToken || req.headers["x-refresh-token"];

  if (!refreshToken) {
    return res.status(400).json({ error: "BadRequest", message: "Refresh token is required." });
  }

  const decoded = verifyRefreshToken(refreshToken);
  if (!decoded || !decoded.id) {
    return res.status(401).json({ error: "InvalidToken", message: "Invalid or expired refresh token. Please sign in again." });
  }

  const user = findUserById(decoded.id);
  if (!user) {
    return res.status(401).json({ error: "UserNotFound", message: "User account no longer exists." });
  }

  const userPayload = {
    id: user.id,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatar_url,
    githubId: user.github_id,
    githubAccessToken: user.github_access_token,
    sessionId: decoded.sessionId,
    hasGithub: Boolean(user.github_access_token),
  };

  const tokens = generateTokenPair(userPayload);

  res.json({
    success: true,
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    user: userPayload,
  });
}

/**
 * GET /api/auth/github — Redirect to GitHub OAuth Authorization page.
 */
export function githubLoginRedirect(req, res) {
  if (!config.githubClientId) {
    return res.redirect("/?github_modal=true");
  }
  const redirectUri = `${config.publicUrl || `http://localhost:${config.port}`}/api/auth/github/callback`;
  const githubUrl = `https://github.com/login/oauth/authorize?client_id=${config.githubClientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&scope=repo,read:user,user:email`;
  res.redirect(githubUrl);
}

/**
 * POST /api/auth/connect-github — Link GitHub Token to Logged-in User Account.
 */
export async function connectGithubToken(req, res) {
  const { token } = req.body;
  const userId = req.user?.id;

  if (!token || typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "BadRequest", message: "Missing GitHub token string." });
  }

  const cleanToken = token.trim();

  try {
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        "User-Agent": "ATH-IDE-Studio",
      },
    });

    if (!userResponse.ok) {
      const errBody = await userResponse.text();
      logger.warn(`GitHub token validation failed: HTTP ${userResponse.status}`, { response: errBody.slice(0, 150) });
      return res.status(400).json({
        error: "AuthFailed",
        message: "Invalid GitHub Token. Please make sure you generated a token with 'repo' and 'read:user' scopes.",
      });
    }

    const githubUser = await userResponse.json();

    let user = null;
    if (userId) {
      updateUserProfile(userId, {
        avatarUrl: githubUser.avatar_url,
        githubId: githubUser.id,
        githubAccessToken: cleanToken,
      });
      user = findUserById(userId);
    }

    const updatedToken = generateToken({
      id: user?.id || userId || `usr_${githubUser.id}`,
      username: user?.username || githubUser.login,
      email: user?.email || githubUser.email || `${githubUser.login}@github.user`,
      avatarUrl: githubUser.avatar_url,
      githubId: githubUser.id,
      githubAccessToken: cleanToken,
      hasGithub: true,
    });

    res.json({
      success: true,
      token: updatedToken,
      githubUser: {
        id: githubUser.id,
        username: githubUser.login,
        avatarUrl: githubUser.avatar_url,
      },
      user: {
        id: user?.id || userId || `usr_${githubUser.id}`,
        username: user?.username || githubUser.login,
        avatarUrl: githubUser.avatar_url,
        hasGithub: true,
      },
      githubToken: cleanToken,
    });
  } catch (err) {
    logger.error("GitHub connect error", { error: err.message });
    res.status(400).json({ error: "AuthFailed", message: err.message });
  }
}

/**
 * POST /api/auth/token-login — Connect with GitHub Access Token directly.
 */
export async function tokenLogin(req, res) {
  const { token } = req.body;

  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "Missing GitHub token." });
  }

  try {
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "User-Agent": "ATH-IDE-Studio",
      },
    });

    if (!userResponse.ok) {
      throw new Error("Invalid GitHub token or insufficient permissions.");
    }

    const githubUser = await userResponse.json();

    let user = findUserByGithubId(githubUser.id);
    if (!user) {
      const userId = uuidv4();
      createUser({
        id: userId,
        githubId: githubUser.id,
        username: githubUser.login,
        email: githubUser.email || `${githubUser.login}@github.user`,
        avatarUrl: githubUser.avatar_url,
        githubAccessToken: token.trim(),
      });
      user = findUserById(userId);
    } else {
      updateUserToken(user.id, token.trim());
      user.github_access_token = token.trim();
    }

    const guestId = req.body.guestId;
    if (guestId) {
      migrateGuestRecords(`usr_${guestId}`, user.id).catch(() => {});
    }

    const jwtToken = generateToken({
      id: user.id,
      username: user.username,
      githubId: user.github_id,
      avatarUrl: user.avatar_url,
      githubAccessToken: user.github_access_token,
    });

    res.json({
      success: true,
      token: jwtToken,
      githubToken: token.trim(),
      user: {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (err) {
    logger.error("Token login error", { error: err.message });
    res.status(400).json({ error: "AuthFailed", message: err.message });
  }
}

/**
 * GET /api/auth/github/callback — Exchange OAuth code for token.
 */
export async function githubCallback(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "BadRequest", message: "Missing OAuth code." });
  }

  try {
    // 1. Exchange code for access_token
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error || !tokenData.access_token) {
      throw new Error(tokenData.error_description || "Failed to exchange GitHub token.");
    }

    const githubAccessToken = tokenData.access_token;

    // 2. Fetch GitHub User Profile
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${githubAccessToken}`,
        "User-Agent": "Agentic-CLI-Studio",
      },
    });

    const githubUser = await userResponse.json();

    // 3. Upsert user in database
    let user = findUserByGithubId(githubUser.id);
    if (!user) {
      const userId = uuidv4();
      createUser({
        id: userId,
        githubId: githubUser.id,
        username: githubUser.login,
        email: githubUser.email || `${githubUser.login}@github.user`,
        avatarUrl: githubUser.avatar_url,
        githubAccessToken,
      });
      user = findUserById(userId);
    } else {
      updateUserToken(user.id, githubAccessToken);
      user.github_access_token = githubAccessToken;
    }

    // 4. Issue JWT
    const jwtToken = generateToken({
      id: user.id,
      username: user.username,
      githubId: user.github_id,
      avatarUrl: user.avatar_url,
      githubAccessToken: user.github_access_token,
    });

    // 5. Redirect back to frontend IDE with tokens
    res.redirect(`/?token=${jwtToken}&github_token=${githubAccessToken}`);
  } catch (err) {
    logger.error("GitHub OAuth callback error", { error: err.message });
    res.status(500).redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
}

/**
 * GET /api/auth/me — Return current logged-in user profile.
 */
export function getMe(req, res) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      avatarUrl: req.user.avatarUrl,
      isGuest: Boolean(req.user.isGuest),
      hasGithub: Boolean(req.user.githubAccessToken),
    },
  });
}

/**
 * POST /api/auth/logout — Log user out.
 */
export function logout(req, res) {
  res.json({ success: true, message: "Logged out successfully." });
}
